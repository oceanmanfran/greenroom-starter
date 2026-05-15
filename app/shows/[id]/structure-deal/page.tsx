import { notFound } from "next/navigation";
import { getShowById } from "@/lib/queries";
import StructureDealClient from "./StructureDealClient";

export default async function StructureDealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getShowById(id);
  if (!data || !data.deal) notFound();

  const { show, artist, agent, agency, deal } = data;

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
    />
  );
}
