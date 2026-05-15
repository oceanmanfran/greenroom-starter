import { notFound } from "next/navigation";
import { getShowById } from "@/lib/queries";
import StructureDealClient from "./StructureDealClient";
import { parseBonuses, parseDealRecoups } from "@/lib/dealMath";
import type { ExtractedDeal, ExtractedBonus } from "@/lib/ai";

export default async function StructureDealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getShowById(id);
  if (!data || !data.deal) notFound();

  const { show, artist, agent, agency, deal } = data;

  // Hydrate the structured form from saved fields when present, so a
  // user landing on /structure-deal for a sent/locked deal sees the
  // agreed terms rather than an empty workspace.
  const savedRecoups = parseDealRecoups(deal);
  const savedBonuses = parseBonuses(deal);
  const hasStructured =
    savedRecoups.length > 0 ||
    savedBonuses.length > 0 ||
    deal.confirmationStatus !== "draft";
  const initialStructured: ExtractedDeal | null = hasStructured
    ? {
        dealType: deal.dealType,
        guaranteeAmount: deal.guaranteeAmount,
        percentage: deal.percentage,
        percentageBasis: deal.percentageBasis,
        expenseCap: deal.expenseCap,
        hospitalityCap: deal.hospitalityCap,
        recoups: savedRecoups,
        bonuses: savedBonuses.map((b, i): ExtractedBonus => {
          if (b.type === "tier_ratchet") {
            return {
              id: `bonus_${i}`,
              type: "tier_ratchet",
              label: b.label,
              tiers: b.tiers,
              source: null,
            };
          }
          if (b.type === "sellout") {
            return {
              id: `bonus_${i}`,
              type: "sellout",
              label: b.label,
              amount: b.amount,
              source: null,
            };
          }
          return {
            id: `bonus_${i}`,
            type: b.type,
            label: b.label,
            threshold: b.threshold,
            amount: b.amount,
            source: null,
          };
        }),
      }
    : null;

  return (
    <StructureDealClient
      dealId={deal.id}
      showId={show.id}
      artistName={artist?.name ?? "—"}
      agent={
        agent
          ? { agentName: agent.name, agencyName: agency?.name ?? null }
          : null
      }
      initialProse={deal.dealNotesFreetext ?? ""}
      initialConfirmationStatus={deal.confirmationStatus}
      initialToken={deal.confirmationToken}
      initialStructured={initialStructured}
      initialViewedAt={deal.viewedByAgentAt ? deal.viewedByAgentAt.toISOString() : null}
      initialConfirmedAt={deal.confirmedByAgentAt ? deal.confirmedByAgentAt.toISOString() : null}
      initialAgentNotes={deal.agentNotes}
    />
  );
}
