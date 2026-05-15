"use server";

/**
 * Server actions for the shared-deal-artifact slice.
 *
 * Booker-side:
 *   - extractDealAction: paste prose, get structured terms + ambiguities back.
 *     No write. The client renders the result and lets the booker resolve
 *     ambiguities, edit fields, then save.
 *   - saveStructuredDealAction: write the resolved structured fields back to
 *     the deal row (recoups with explicit scope, deduction order, bonuses).
 *   - sendToAgentAction: generate a magic-link token, flip status to
 *     "sent_to_agent", return the link the booker can copy.
 *
 * Agent-side:
 *   - markViewedAction: agent's browser hits the magic link, we record it.
 *   - confirmDealAction: agent signs off, deal becomes "locked".
 *   - disputeDealAction: agent flags an issue with notes, deal becomes "disputed".
 */

import { db } from "@/db";
import { deals } from "@/db/schema";
import type { DealRecoup, DeductionStep } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { extractAndAnalyzeDeal, type ExtractionResult } from "@/lib/ai";
import { getAgentContextForShow } from "@/lib/queries";

// ---------- booker side ----------

export async function extractDealAction(
  showId: string,
  prose: string,
): Promise<ExtractionResult> {
  const agent = await getAgentContextForShow(showId);
  return extractAndAnalyzeDeal(prose, agent);
}

export type SaveStructuredDealInput = {
  dealId: string;
  dealType: "flat" | "percentage_of_gross" | "percentage_of_net" | "vs" | "door";
  guaranteeAmount: number | null;
  percentage: number | null;
  percentageBasis: "gross" | "net" | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
  dealRecoups: DealRecoup[];
  deductionOrder: DeductionStep[];
  bonuses: unknown[];
  dealNotesFreetext: string | null;
};

export async function saveStructuredDealAction(
  input: SaveStructuredDealInput,
): Promise<
  | { ok: true; newStatus: string; resetFromLocked: boolean }
  | { ok: false; reason: string }
> {
  const unresolved = input.dealRecoups.filter((r) => r.scope === "unresolved");
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: `${unresolved.length} recoup${unresolved.length === 1 ? "" : "s"} still have an unresolved scope. Pick inside cap, outside cap, or against gross before saving.`,
    };
  }

  const current = (await db.select().from(deals).where(eq(deals.id, input.dealId)))[0];
  if (!current) return { ok: false, reason: "Deal not found" };

  // Amending a previously-locked or disputed deal invalidates the agent's
  // signoff. Reset status to draft so the settle calculator refuses to run
  // until the agent re-confirms. Magic-link token is also cleared so the
  // old link 404s instead of pointing at stale terms.
  const wasFinal = current.confirmationStatus === "locked" || current.confirmationStatus === "disputed";
  const nextStatus = wasFinal ? "draft" : current.confirmationStatus;

  await db
    .update(deals)
    .set({
      dealType: input.dealType,
      guaranteeAmount: input.guaranteeAmount,
      percentage: input.percentage,
      percentageBasis: input.percentageBasis,
      expenseCap: input.expenseCap,
      hospitalityCap: input.hospitalityCap,
      dealRecoupsJson: JSON.stringify(input.dealRecoups),
      deductionOrder: JSON.stringify(input.deductionOrder),
      bonusesJson:
        input.bonuses && input.bonuses.length > 0
          ? JSON.stringify(input.bonuses)
          : null,
      dealNotesFreetext: input.dealNotesFreetext,
      ...(wasFinal
        ? {
            confirmationStatus: "draft" as const,
            confirmationToken: null,
            lockedAt: null,
            // Preserve sent/viewed/confirmed timestamps as audit history,
            // but clear lock so settle gates correctly until re-send.
          }
        : {}),
    })
    .where(eq(deals.id, input.dealId));

  revalidatePath(`/shows/${current.showId}`);
  revalidatePath(`/shows/${current.showId}/structure-deal`);

  return { ok: true, newStatus: nextStatus, resetFromLocked: wasFinal };
}

export async function sendToAgentAction(
  dealId: string,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const rows = await db.select().from(deals).where(eq(deals.id, dealId));
  const d = rows[0];
  if (!d) return { ok: false, reason: "Deal not found" };
  if (d.dealRecoupsJson) {
    try {
      const recoups = JSON.parse(d.dealRecoupsJson) as DealRecoup[];
      const unresolved = recoups.filter((r) => r.scope === "unresolved");
      if (unresolved.length > 0) {
        return {
          ok: false,
          reason: "Can't send a deal that still has unresolved recoup scopes.",
        };
      }
    } catch {
      // ignore malformed
    }
  }

  const token = randomToken(d.id);
  await db
    .update(deals)
    .set({
      confirmationStatus: "sent_to_agent",
      confirmationToken: token,
      sentToAgentAt: new Date(),
    })
    .where(eq(deals.id, dealId));

  revalidatePath(`/shows/${d.showId}`);
  return { ok: true, token };
}

// ---------- agent side ----------

export async function markViewedAction(token: string): Promise<void> {
  const rows = await db
    .select()
    .from(deals)
    .where(eq(deals.confirmationToken, token));
  const d = rows[0];
  if (!d || d.viewedByAgentAt || d.confirmationStatus === "locked") return;
  await db
    .update(deals)
    .set({
      confirmationStatus: d.confirmationStatus === "sent_to_agent" ? "viewed" : d.confirmationStatus,
      viewedByAgentAt: new Date(),
    })
    .where(eq(deals.confirmationToken, token));
}

export async function confirmDealAction(
  token: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rows = await db
    .select()
    .from(deals)
    .where(eq(deals.confirmationToken, token));
  const d = rows[0];
  if (!d) return { ok: false, reason: "Invalid token" };
  if (d.confirmationStatus === "locked") return { ok: true };

  const now = new Date();
  await db
    .update(deals)
    .set({
      confirmationStatus: "locked",
      confirmedByAgentAt: now,
      lockedAt: now,
    })
    .where(eq(deals.confirmationToken, token));

  revalidatePath(`/shows/${d.showId}`);
  return { ok: true };
}

export async function disputeDealAction(
  token: string,
  notes: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rows = await db
    .select()
    .from(deals)
    .where(eq(deals.confirmationToken, token));
  const d = rows[0];
  if (!d) return { ok: false, reason: "Invalid token" };

  await db
    .update(deals)
    .set({
      confirmationStatus: "disputed",
      agentNotes: notes,
    })
    .where(eq(deals.confirmationToken, token));

  revalidatePath(`/shows/${d.showId}`);
  return { ok: true };
}

// ---------- helpers ----------

function randomToken(dealId: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `tok_${dealId.slice(0, 16)}_${ts}_${rand}`;
}
