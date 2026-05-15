/**
 * Deal calculation logic for the in-app settlement tool.
 *
 * Extended for the shared-deal-artifact slice. The original engine
 * handled only flat and percentage_of_gross. This version also handles
 * vs and percentage_of_net, which together cover ~59% of past deals
 * at The Crescent.
 *
 * The new logic depends on the deal being locked: the calculator
 * refuses to settle anything that hasn't been confirmed by both
 * parties, because the recoup scopes (inside_cap vs outside_cap vs
 * against_gross) are the inputs that resolve the Coastal Spell-class
 * ambiguity. Settling against an unconfirmed deal would re-introduce
 * the same disputes the slice is built to prevent.
 *
 * Door deals remain unsupported.
 *
 * Every step in the returned worksheet carries a `source` pointer so
 * the UI can surface "where did this number come from" for line-level
 * trust.
 */

import type {
  Deal,
  Expense,
  TicketSale,
  Bonus,
  DealRecoup,
} from "@/db/schema";

export type CalcStep = {
  label: string;
  value: number;
  op: "add" | "subtract" | "multiply" | "info" | "max";
  note?: string;
  /** Provenance: where this number came from. */
  source?: {
    kind:
      | "ticket_sales"
      | "expenses"
      | "deal_clause"
      | "deal_recoup"
      | "bonus"
      | "computed";
    label: string;
    ref?: string;
  };
};

export type SettlementCalculation =
  | {
      supported: true;
      grossBoxOffice: number;
      netBoxOffice: number;
      totalExpenses: number;
      totalToArtist: number;
      steps: CalcStep[];
      finalFormula: string;
      bonusesApplied: { label: string; amount: number; reason: string }[];
      bonusesNotTriggered: { label: string; amount: number; reason: string }[];
      /**
       * Soft warnings the math ran past. Examples: expenses ran over the cap
       * (we still applied the cap, but the booker should know), or net came
       * out negative before the guarantee kicked in. These don't block
       * settlement, they're surfaced inline.
       */
      warnings: string[];
    }
  | {
      supported: false;
      reason: string;
      dealType: Deal["dealType"];
      /**
       * Where the user should go to make the calc work. The settle page
       * uses this to render a useful empty state instead of a dead end.
       */
      remediation?:
        | { kind: "structure_deal"; showId: string }
        | { kind: "missing_field"; field: string }
        | { kind: "deal_type_unsupported" };
    };

interface CalcInput {
  deal: Deal;
  ticketSales: TicketSale[];
  expenses: Expense[];
  venueCapacity?: number;
  ticketsSold?: number;
  /**
   * If true, the calculator refuses to run vs and percentage_of_net
   * calculations against unconfirmed deals. The settle page passes this
   * so the gating is enforced at math time, not just UI time.
   */
  requireLocked?: boolean;
  showId?: string;
}

// ---------------- parsers ----------------

export function parseBonuses(deal: Deal): Bonus[] {
  if (!deal.bonusesJson) return [];
  try {
    const parsed = JSON.parse(deal.bonusesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseDealRecoups(deal: Deal): DealRecoup[] {
  if (!deal.dealRecoupsJson) return [];
  try {
    const parsed = JSON.parse(deal.dealRecoupsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------- engine ----------------

export function calculateSettlement(input: CalcInput): SettlementCalculation {
  const {
    deal,
    ticketSales,
    expenses,
    venueCapacity,
    ticketsSold,
    requireLocked = false,
    showId,
  } = input;

  // Door deals stay unsupported.
  if (deal.dealType === "door") {
    return {
      supported: false,
      dealType: deal.dealType,
      reason:
        "Door deals aren't supported in the in-app tool yet. Bookers default to spreadsheets for these.",
      remediation: { kind: "deal_type_unsupported" },
    };
  }

  const needsLock =
    deal.dealType === "vs" || deal.dealType === "percentage_of_net";
  if (needsLock && requireLocked && deal.confirmationStatus !== "locked") {
    return {
      supported: false,
      dealType: deal.dealType,
      reason:
        "This deal hasn't been confirmed by the agent yet. The settlement calculator refuses to run against an unconfirmed deal: the recoup scopes (inside cap / outside cap / against gross) are what prevent the Coastal Spell-class dispute, and they only count once both sides have signed off.",
      remediation: showId
        ? { kind: "structure_deal", showId }
        : { kind: "deal_type_unsupported" },
    };
  }

  // Common arithmetic
  const grossBoxOffice = ticketSales.reduce((s, t) => s + t.gross, 0);
  const totalFees = ticketSales.reduce((s, t) => s + t.fees, 0);
  const grossNetOfFees = grossBoxOffice - totalFees;
  const passThroughExpenses = expenses.filter((e) => !e.absorbedByVenue);
  const totalExpenses = passThroughExpenses.reduce((s, e) => s + e.amount, 0);
  const expenseRowCount = passThroughExpenses.length;
  const tickets =
    ticketsSold ?? ticketSales.reduce((s, t) => s + (t.qty ?? 0), 0);

  const recoups = parseDealRecoups(deal);
  const againstGrossList = recoups.filter((r) => r.scope === "against_gross");
  const outsideCapList = recoups.filter((r) => r.scope === "outside_cap");
  const insideCapList = recoups.filter((r) => r.scope === "inside_cap");
  const unresolvedList = recoups.filter((r) => r.scope === "unresolved");

  const againstGross = againstGrossList.reduce((s, r) => s + r.amount, 0);
  const outsideCap = outsideCapList.reduce((s, r) => s + r.amount, 0);
  const insideCap = insideCapList.reduce((s, r) => s + r.amount, 0);

  const warnings: string[] = [];
  if (unresolvedList.length > 0) {
    warnings.push(
      `${unresolvedList.length} recoup${unresolvedList.length === 1 ? "" : "s"} have unresolved scope. They're being treated as outside-cap for this calculation, but the deal should have been blocked from locking with these still unresolved.`,
    );
  }

  const expenseCap = deal.expenseCap;
  // Cap interpretation. Industry deals use both readings:
  //   - "ceiling": deduct actual expenses up to the cap. Used by the original
  //     seed math and consistent with how shows that never went through the
  //     structured flow were historically settled.
  //   - "fixed": the cap IS the deduction, regardless of actual spend.
  //     Treated as an expense allowance. This is what the Coastal Spell
  //     dispute thread shows both parties using (which is why their
  //     interpretations diverged on the $900 marketing recoup).
  //
  // Heuristic: deals that went through the new structured flow have
  // recoups configured with explicit scope, so we know they're modeling
  // the "fixed" world. Deals without structured recoups fall back to
  // the ceiling reading so historical totals stay reproducible.
  const useFixedCap = expenseCap != null && recoups.length > 0;
  const expensesPlusInside = totalExpenses + insideCap;
  let cappedExpenses: number;
  if (useFixedCap) {
    // Fixed deduction. Inside-cap recoups are "covered" by the cap so
    // they don't add to the deduction. Outside-cap recoups remain a
    // separate line in the net calculation below.
    cappedExpenses = expenseCap;
  } else {
    cappedExpenses =
      expenseCap != null
        ? Math.min(expensesPlusInside, expenseCap)
        : expensesPlusInside;
  }
  if (expenseCap != null && expensesPlusInside > expenseCap) {
    const overage = expensesPlusInside - expenseCap;
    warnings.push(
      `Expenses ran $${overage.toLocaleString()} over the $${expenseCap.toLocaleString()} cap. The overage isn't deducted from the artist's share. Confirm absorption with the GM.`,
    );
  }
  if (useFixedCap && totalExpenses < expenseCap && insideCapList.length === 0) {
    const underrun = expenseCap - totalExpenses;
    warnings.push(
      `Actual expenses ($${totalExpenses.toLocaleString()}) ran $${underrun.toLocaleString()} under the cap. The cap is being applied as a fixed deduction per the confirmed deal terms.`,
    );
  }

  // For unresolved recoups we still want the math to run, so we lump them
  // into outside-cap (the conservative-for-artist read). This matches the
  // warning text above.
  const unresolvedTotal = unresolvedList.reduce((s, r) => s + r.amount, 0);

  const netForPercent =
    grossNetOfFees -
    againstGross -
    outsideCap -
    unresolvedTotal -
    cappedExpenses;
  const netClamped = Math.max(0, netForPercent);
  if (netForPercent < 0) {
    warnings.push(
      "Net came out below zero. The percent payout is clamped to $0; the guarantee floor (if any) will carry the deal.",
    );
  }

  const bonusResult = applyBonuses(parseBonuses(deal), {
    gross: grossBoxOffice,
    tickets,
    capacity: venueCapacity,
  });

  // ----- per-deal-type math -----

  if (deal.dealType === "flat") {
    if (deal.guaranteeAmount == null) {
      return {
        supported: false,
        dealType: deal.dealType,
        reason: "Flat deal is missing a guarantee amount.",
        remediation: { kind: "missing_field", field: "guaranteeAmount" },
      };
    }
    const totalToArtist = deal.guaranteeAmount + bonusResult.totalApplied;
    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice: grossNetOfFees,
      totalExpenses,
      totalToArtist,
      steps: [
        {
          label: "Flat guarantee",
          value: deal.guaranteeAmount,
          op: "info",
          note: "The guarantee is the floor. Expenses don't change the payout.",
          source: {
            kind: "deal_clause",
            label: `Guarantee: $${deal.guaranteeAmount.toLocaleString()}`,
            ref: "deals.guaranteeAmount",
          },
        },
        ...bonusResult.applied.map((b) => bonusStep(b)),
      ],
      finalFormula: bonusResult.applied.length
        ? `flat ${deal.guaranteeAmount} + bonuses ${bonusResult.totalApplied} = ${totalToArtist}`
        : `flat guarantee = ${deal.guaranteeAmount}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
      warnings,
    };
  }

  if (deal.dealType === "percentage_of_gross") {
    if (deal.percentage == null) {
      return {
        supported: false,
        dealType: deal.dealType,
        reason: "% of gross deal is missing a percentage.",
        remediation: { kind: "missing_field", field: "percentage" },
      };
    }
    const payout = grossBoxOffice * deal.percentage;
    const totalToArtist = payout + bonusResult.totalApplied;
    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice: grossNetOfFees,
      totalExpenses,
      totalToArtist,
      steps: [
        grossStep(grossBoxOffice, ticketSales.length),
        {
          label: `× ${(deal.percentage * 100).toFixed(0)}% of gross`,
          value: payout,
          op: "multiply",
          note: "Percentage of gross. No expense deductions.",
          source: {
            kind: "deal_clause",
            label: `${(deal.percentage * 100).toFixed(0)}% of gross`,
            ref: "deals.percentage",
          },
        },
        ...bonusResult.applied.map((b) => bonusStep(b)),
      ],
      finalFormula: bonusResult.applied.length
        ? `gross × ${deal.percentage} + bonuses = ${totalToArtist.toFixed(2)}`
        : `gross × ${deal.percentage} = ${payout.toFixed(2)}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
      warnings,
    };
  }

  const netSteps = buildNetSteps({
    grossBoxOffice,
    ticketSalesCount: ticketSales.length,
    totalFees,
    againstGrossRecoups: againstGrossList,
    outsideCapRecoups: [...outsideCapList, ...unresolvedList],
    insideCapRecoups: insideCapList,
    totalExpenses,
    expenseRowCount,
    cappedExpenses,
    expenseCap,
    netForPercent,
  });

  if (deal.dealType === "percentage_of_net") {
    if (deal.percentage == null) {
      return {
        supported: false,
        dealType: deal.dealType,
        reason: "% of net deal is missing a percentage.",
        remediation: { kind: "missing_field", field: "percentage" },
      };
    }
    const percentPayout = netClamped * deal.percentage;
    const totalToArtist = percentPayout + bonusResult.totalApplied;
    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice: netForPercent,
      totalExpenses,
      totalToArtist,
      steps: [
        ...netSteps,
        {
          label: `× ${(deal.percentage * 100).toFixed(0)}% of net`,
          value: percentPayout,
          op: "multiply",
          note: "Percentage of net.",
          source: {
            kind: "deal_clause",
            label: `${(deal.percentage * 100).toFixed(0)}% of net`,
            ref: "deals.percentage",
          },
        },
        ...bonusResult.applied.map((b) => bonusStep(b)),
      ],
      finalFormula: bonusResult.applied.length
        ? `net × ${deal.percentage} + bonuses = ${totalToArtist.toFixed(2)}`
        : `net × ${deal.percentage} = ${percentPayout.toFixed(2)}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
      warnings,
    };
  }

  if (deal.dealType === "vs") {
    if (deal.guaranteeAmount == null || deal.percentage == null) {
      return {
        supported: false,
        dealType: deal.dealType,
        reason: "Vs deal is missing a guarantee and/or percentage.",
        remediation: {
          kind: "missing_field",
          field: deal.guaranteeAmount == null ? "guaranteeAmount" : "percentage",
        },
      };
    }
    const percentPayout = netClamped * deal.percentage;
    const guaranteeWins = deal.guaranteeAmount >= percentPayout;
    const payout = Math.max(deal.guaranteeAmount, percentPayout);
    const totalToArtist = payout + bonusResult.totalApplied;

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice: netForPercent,
      totalExpenses,
      totalToArtist,
      steps: [
        ...netSteps,
        {
          label: `× ${(deal.percentage * 100).toFixed(0)}% of net`,
          value: percentPayout,
          op: "multiply",
          note: "Percentage applied to net after deductions.",
          source: {
            kind: "deal_clause",
            label: `${(deal.percentage * 100).toFixed(0)}% of net`,
            ref: "deals.percentage",
          },
        },
        {
          label: "Guarantee floor",
          value: deal.guaranteeAmount,
          op: "info",
          source: {
            kind: "deal_clause",
            label: `Guarantee: $${deal.guaranteeAmount.toLocaleString()}`,
            ref: "deals.guaranteeAmount",
          },
        },
        {
          label: guaranteeWins ? "Guarantee wins" : "Percentage wins",
          value: payout,
          op: "max",
          note: guaranteeWins
            ? `Guarantee $${deal.guaranteeAmount.toLocaleString()} ≥ % payout $${percentPayout.toFixed(2)}`
            : `% payout $${percentPayout.toFixed(2)} > guarantee $${deal.guaranteeAmount.toLocaleString()}`,
          source: { kind: "computed", label: "max(guarantee, % × net)" },
        },
        ...bonusResult.applied.map((b) => bonusStep(b)),
      ],
      finalFormula: bonusResult.applied.length
        ? `max(${deal.guaranteeAmount}, ${deal.percentage} × ${netForPercent.toFixed(2)}) + bonuses = ${totalToArtist.toFixed(2)}`
        : `max(${deal.guaranteeAmount}, ${deal.percentage} × ${netForPercent.toFixed(2)}) = ${payout.toFixed(2)}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
      warnings,
    };
  }

  return {
    supported: false,
    dealType: deal.dealType,
    reason: "Unknown deal type.",
    remediation: { kind: "deal_type_unsupported" },
  };
}

// ---------------- step builders ----------------

function grossStep(grossBoxOffice: number, rowCount: number): CalcStep {
  return {
    label: "Gross box office",
    value: grossBoxOffice,
    op: "info",
    source: {
      kind: "ticket_sales",
      label: `${rowCount} ticket-sale row${rowCount === 1 ? "" : "s"}`,
      ref: "ticket_sales",
    },
  };
}

function buildNetSteps(args: {
  grossBoxOffice: number;
  ticketSalesCount: number;
  totalFees: number;
  againstGrossRecoups: DealRecoup[];
  outsideCapRecoups: DealRecoup[];
  insideCapRecoups: DealRecoup[];
  totalExpenses: number;
  expenseRowCount: number;
  cappedExpenses: number;
  expenseCap: number | null;
  netForPercent: number;
}): CalcStep[] {
  const {
    grossBoxOffice,
    ticketSalesCount,
    totalFees,
    againstGrossRecoups,
    outsideCapRecoups,
    insideCapRecoups,
    totalExpenses,
    expenseRowCount,
    cappedExpenses,
    expenseCap,
    netForPercent,
  } = args;

  const steps: CalcStep[] = [grossStep(grossBoxOffice, ticketSalesCount)];

  if (totalFees > 0) {
    steps.push({
      label: "Less ticketing + CC fees",
      value: -totalFees,
      op: "subtract",
      source: {
        kind: "ticket_sales",
        label: `Fees from ${ticketSalesCount} ticket-sale row${ticketSalesCount === 1 ? "" : "s"}`,
        ref: "ticket_sales.fees",
      },
    });
  }

  for (const r of againstGrossRecoups) {
    steps.push({
      label: `Less ${r.label}`,
      value: -r.amount,
      op: "subtract",
      note: "Against gross. Comes off before the cap.",
      source: {
        kind: "deal_recoup",
        label: `${r.category} · ${r.scope}`,
        ref: r.id,
      },
    });
  }

  for (const r of outsideCapRecoups) {
    steps.push({
      label: `Less ${r.label}`,
      value: -r.amount,
      op: "subtract",
      note: "On top of the expense cap.",
      source: {
        kind: "deal_recoup",
        label: `${r.category} · ${r.scope}`,
        ref: r.id,
      },
    });
  }

  if (insideCapRecoups.length > 0) {
    const insideTotal = insideCapRecoups.reduce((s, r) => s + r.amount, 0);
    steps.push({
      label: `Inside-cap recoups added to expenses`,
      value: insideTotal,
      op: "info",
      note: "Counted toward the expense cap, not stacked on top.",
      source: {
        kind: "deal_recoup",
        label: `${insideCapRecoups.length} recoup${insideCapRecoups.length === 1 ? "" : "s"} inside cap`,
      },
    });
  }

  const expensesPlusInside =
    totalExpenses + insideCapRecoups.reduce((s, r) => s + r.amount, 0);
  const capLabel =
    expenseCap != null
      ? `Less expenses (capped at $${expenseCap.toLocaleString()})`
      : "Less expenses";
  steps.push({
    label: capLabel,
    value: -cappedExpenses,
    op: "subtract",
    note:
      expenseCap != null && expensesPlusInside > expenseCap
        ? `Actual $${expensesPlusInside.toLocaleString()} > cap. Overage absorbed by venue.`
        : undefined,
    source: {
      kind: "expenses",
      label: `${expenseRowCount} expense row${expenseRowCount === 1 ? "" : "s"}`,
      ref: "expenses",
    },
  });

  steps.push({
    label: "Net",
    value: netForPercent,
    op: "info",
    source: { kind: "computed", label: "gross − fees − recoups − capped expenses" },
  });

  return steps;
}

function bonusStep(b: { label: string; amount: number; reason: string }): CalcStep {
  return {
    label: b.label,
    value: b.amount,
    op: "add",
    note: b.reason,
    source: { kind: "bonus", label: b.label, ref: "deals.bonusesJson" },
  };
}

// ---------------- bonuses ----------------

function applyBonuses(
  bonuses: Bonus[],
  ctx: { gross: number; tickets: number; capacity?: number },
) {
  const applied: { label: string; amount: number; reason: string }[] = [];
  const notTriggered: { label: string; amount: number; reason: string }[] = [];

  for (const b of bonuses) {
    if (b.type === "gross_threshold") {
      if (ctx.gross >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} ≥ ${b.threshold.toLocaleString()}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross ${ctx.gross.toLocaleString()} < ${b.threshold.toLocaleString()}`,
        });
      }
    } else if (b.type === "sellout") {
      if (ctx.capacity != null && ctx.tickets >= ctx.capacity * 0.95) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} of ${ctx.capacity} sold`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason:
            ctx.capacity != null
              ? `${ctx.tickets} of ${ctx.capacity} sold (sellout = ≥95%)`
              : `Capacity unknown — can't evaluate`,
        });
      }
    } else if (b.type === "attendance_threshold") {
      if (ctx.tickets >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} ≥ ${b.threshold}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} < ${b.threshold}`,
        });
      }
    } else if (b.type === "tier_ratchet") {
      notTriggered.push({
        label: b.label,
        amount: 0,
        reason: "Tier ratchets need attendance-tier resolution — flag for the booker",
      });
    }
  }

  return {
    applied,
    notTriggered,
    totalApplied: applied.reduce((s, b) => s + b.amount, 0),
  };
}
