import { notFound } from "next/navigation";
import { db } from "@/db";
import { deals, shows, artists, agents, agencies, venues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { markViewedAction } from "@/lib/dealActions";
import { summarizeDealForAgent } from "@/lib/ai";
import type { DealRecoup } from "@/db/schema";
import AgentReviewClient from "./AgentReviewClient";
import { formatShowDateFull } from "@/lib/format";

export default async function AgentReviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const rows = await db
    .select({
      deal: deals,
      show: shows,
      artist: artists,
      agent: agents,
      agency: agencies,
      venue: venues,
    })
    .from(deals)
    .leftJoin(shows, eq(deals.showId, shows.id))
    .leftJoin(artists, eq(shows.artistId, artists.id))
    .leftJoin(agents, eq(artists.agentId, agents.id))
    .leftJoin(agencies, eq(agents.agencyId, agencies.id))
    .leftJoin(venues, eq(shows.venueId, venues.id))
    .where(eq(deals.confirmationToken, token));

  const row = rows[0];
  if (!row?.deal || !row.show) notFound();

  await markViewedAction(token);

  const dealRecoups: DealRecoup[] = row.deal.dealRecoupsJson
    ? safeParse<DealRecoup[]>(row.deal.dealRecoupsJson, [])
    : [];

  const extracted = {
    dealType: row.deal.dealType,
    guaranteeAmount: row.deal.guaranteeAmount,
    percentage: row.deal.percentage,
    percentageBasis: row.deal.percentageBasis,
    expenseCap: row.deal.expenseCap,
    hospitalityCap: row.deal.hospitalityCap,
    recoups: dealRecoups,
    bonuses: row.deal.bonusesJson
      ? safeParse<unknown[]>(row.deal.bonusesJson, [])
      : [],
  };

  const summary = await summarizeDealForAgent(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extracted as any,
    {
      artistName: row.artist?.name ?? "—",
      venueName: row.venue?.name ?? "The venue",
      showDate: formatShowDateFull(row.show.date),
    },
  );

  return (
    <AgentReviewClient
      token={token}
      status={row.deal.confirmationStatus}
      artistName={row.artist?.name ?? "—"}
      agentName={row.agent?.name ?? "Agent"}
      agencyName={row.agency?.name ?? null}
      venueName={row.venue?.name ?? "The venue"}
      showDate={formatShowDateFull(row.show.date)}
      summary={summary}
      deal={extracted}
    />
  );
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json);
    return parsed as T;
  } catch {
    return fallback;
  }
}
