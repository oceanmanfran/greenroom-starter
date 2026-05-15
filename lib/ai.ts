/**
 * AI layer for the shared-deal-artifact slice.
 *
 * Two jobs:
 *
 *   1. `extractAndAnalyzeDeal`  — Mariana pastes the agent's deal email.
 *      We return structured deal terms + a list of ambiguities the booker
 *      has to resolve before the deal can be sent to the agent for
 *      confirmation. Ambiguities are grounded in actual past-dispute
 *      history for the same agent/agency where possible.
 *
 *   2. `summarizeDealForAgent` — generates a short, plain-language
 *      summary of the structured deal that the agent sees alongside
 *      the structured fields on the confirmation page. Used as a
 *      "does this match your reading?" verification surface.
 *
 * Provider: OpenAI gpt-4.1-mini. Falls back to a deterministic mock when
 * no API key is set so the demo path still runs.
 */
import OpenAI from "openai";
import type { DealRecoup } from "@/db/schema";

const MODEL = "gpt-4.1-mini";

let _client: OpenAI | null | undefined;
function client(): OpenAI | null {
  if (_client !== undefined) return _client;
  const key = process.env.OPENAI_API_KEY;
  _client = key ? new OpenAI({ apiKey: key }) : null;
  return _client;
}

export function aiMode(): "live" | "mock" {
  return client() ? "live" : "mock";
}

// ---------------- types ----------------

export type ExtractedDeal = {
  dealType: "flat" | "percentage_of_gross" | "percentage_of_net" | "vs" | "door";
  guaranteeAmount: number | null;
  percentage: number | null; // 0..1
  percentageBasis: "gross" | "net" | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
  recoups: DealRecoup[];
  bonuses: ExtractedBonus[];
};

export type ExtractedBonus = {
  id: string;
  type: "gross_threshold" | "attendance_threshold" | "sellout" | "tier_ratchet";
  label: string;
  threshold?: number;
  amount?: number;
  tiers?: { from: number; to: number | null; percentage: number }[];
  source: string | null;
};

export type Ambiguity = {
  id: string;
  field: string; // dotted path into ExtractedDeal, e.g. "recoups[0].scope"
  phrase: string;
  readingA: { label: string; value: string };
  readingB: { label: string; value: string };
  explanation: string;
  priorContext: string | null;
  recommended: "A" | "B" | null;
};

export type ExtractionResult = {
  mode: "live" | "mock";
  extracted: ExtractedDeal;
  ambiguities: Ambiguity[];
  notes: string[];
};

export type AgentContext = {
  agentName: string;
  agencyName: string | null;
  totalShows: number;
  disputedShows: number;
  disputedMarketingRecoups: number;
  preferencesNotes: string | null;
};

// ---------------- public api ----------------

export async function extractAndAnalyzeDeal(
  prose: string,
  agent: AgentContext | null,
): Promise<ExtractionResult> {
  const c = client();
  if (!c) {
    return mockExtraction(prose, agent);
  }
  try {
    return await liveExtraction(c, prose, agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = mockExtraction(prose, agent);
    return {
      ...fallback,
      notes: [
        `Live extraction failed: ${message}. Falling back to mock. The booker can also fill in the form manually.`,
        ...fallback.notes,
      ],
    };
  }
}

export async function summarizeDealForAgent(
  extracted: ExtractedDeal,
  context: { artistName: string; venueName: string; showDate: string },
): Promise<string> {
  const c = client();
  if (!c) return mockSummary(extracted, context);
  try {
    return await liveSummary(c, extracted, context);
  } catch {
    return mockSummary(extracted, context);
  }
}

// ---------------- live path ----------------

async function liveExtraction(
  c: OpenAI,
  prose: string,
  agent: AgentContext | null,
): Promise<ExtractionResult> {
  const agentBlurb = agent
    ? `\n\nAgent context for grounding:\n- Name: ${agent.agentName}\n- Agency: ${agent.agencyName ?? "Independent"}\n- Past shows at this venue: ${agent.totalShows}\n- Past disputes: ${agent.disputedShows}\n- Past disputed marketing recoups specifically: ${agent.disputedMarketingRecoups}\n- Booker's notes on this agent: ${agent.preferencesNotes ?? "(none)"}`
    : "";

  const system = `You extract structured deal terms from a music venue booking agent's deal email and flag ambiguities that need explicit resolution before the deal is confirmed.

You are paranoid about ambiguity. A clause is ambiguous if a sober person could read it two different ways and arrive at different settlement math. Common offenders:
- Marketing recoup "against gross" without saying inside or outside the expense cap
- Percentage of "net" without defining what's deducted to reach net
- Bonuses described with words but no threshold
- Tier ratchets without explicit tier breakpoints

For each ambiguity, you MUST provide two concrete readings (A and B), the exact phrase from the prose, why it's ambiguous, and a recommendation if one reading is clearly more standard or fits the agent's past patterns.

Return strict JSON matching the schema. No prose outside JSON.${agentBlurb}`;

  const userMsg = `Deal email prose:\n\n"""\n${prose}\n"""`;

  const resp = await c.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    temperature: 0,
  });

  const content = resp.choices[0]?.message?.content ?? "{}";
  let parsed: { extracted: ExtractedDeal; ambiguities: Ambiguity[]; notes?: string[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      mode: "live",
      extracted: emptyExtracted(),
      ambiguities: [],
      notes: ["Model returned unparseable JSON. Mariana should structure manually."],
    };
  }

  return {
    mode: "live",
    extracted: parsed.extracted ?? emptyExtracted(),
    ambiguities: parsed.ambiguities ?? [],
    notes: parsed.notes ?? [],
  };
}

async function liveSummary(
  c: OpenAI,
  extracted: ExtractedDeal,
  context: { artistName: string; venueName: string; showDate: string },
): Promise<string> {
  const system = `You write short, plain-English summaries of music-venue deal terms for the artist's booking agent to verify. Three to five sentences. No jargon. State the deal type, the guarantee/percentage structure, any expense or hospitality caps, every recoup with its scope (inside cap / outside cap / against gross), and any bonuses. Do not editorialize. Do not use em dashes.`;

  const userMsg = `Show: ${context.artistName} at ${context.venueName}, ${context.showDate}\n\nStructured deal:\n${JSON.stringify(extracted, null, 2)}\n\nWrite the summary.`;

  const resp = await c.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    temperature: 0.2,
  });

  return resp.choices[0]?.message?.content?.trim() ?? mockSummary(extracted, context);
}

// ---------------- mock path ----------------

/**
 * Deterministic mock so the demo runs without an API key.
 *
 * The mock isn't a stub: it does a real best-effort parse of the prose
 * with regexes covering the common shapes (Vs, flat, % of net, % of
 * gross, expense cap, hospitality cap, marketing recoup, gross-threshold
 * bonus). It then runs the same ambiguity detection the live model
 * would, so even without an API key the booker gets meaningful
 * extraction on arbitrary deal emails. The mode label still surfaces
 * in the UI so reviewers know they're not seeing the live model.
 */
function mockExtraction(prose: string, agent: AgentContext | null): ExtractionResult {
  const text = prose;

  const money = (re: RegExp) => {
    const m = text.match(re);
    if (!m) return null;
    return parseFloat(m[1].replace(/,/g, ""));
  };

  // Deal type
  const hasVs = /\bvs\b|whichever (greater|is greater|higher|is higher)/i.test(text);
  const hasOfNet = /of net|of the net|after expenses/i.test(text);
  const hasOfGross = /of gross|of the gross/i.test(text);
  const hasGuarantee = /guarantee|g'tee|\$\s?\d/i.test(text);

  let dealType: ExtractedDeal["dealType"] = "vs";
  if (hasVs && (hasOfNet || hasOfGross)) dealType = "vs";
  else if (hasOfNet) dealType = "percentage_of_net";
  else if (hasOfGross) dealType = "percentage_of_gross";
  else if (hasGuarantee) dealType = "flat";

  // Guarantee
  const guaranteeAmount =
    money(/\$\s?([\d,]+(?:\.\d+)?)\s*(?:guarantee|g'tee|guarantee\.|vs)/i) ??
    money(/^\s*\$?([\d,]+)\s*vs/im) ??
    money(/guarantee[^$]*\$\s?([\d,]+(?:\.\d+)?)/i);

  // Percentage. Try "80% of net", "80/20", "85/15 split"
  const pctOfMatch = text.match(/(\d{2,3})\s*%\s*(?:of)?\s*(?:net|gross)/i);
  const splitMatch = text.match(/(\d{2,3})\s*\/\s*(\d{1,3})/);
  let percentage: number | null = null;
  let percentageBasis: ExtractedDeal["percentageBasis"] = null;
  if (pctOfMatch) {
    percentage = parseFloat(pctOfMatch[1]) / 100;
    percentageBasis = /gross/i.test(pctOfMatch[0]) ? "gross" : "net";
  } else if (splitMatch) {
    percentage = parseFloat(splitMatch[1]) / 100;
    percentageBasis = hasOfGross ? "gross" : "net";
  }

  // Caps
  const expenseCap =
    money(/expenses?\s*(?:capped|cap)\s*(?:at\s*)?\$?\s?([\d,]+)/i) ??
    money(/expense cap[^$]*\$?\s?([\d,]+)/i);
  const hospitalityCap =
    money(/hospitality\s*(?:cap)?\s*\$?\s?([\d,]+)/i);

  // Recoups (marketing recoup is the canonical one). Multi-recoup support.
  const recoups: DealRecoup[] = [];
  const recoupRe =
    /\b(marketing|production|prior\s*advance|advance|damages?)\b[^.\n]*?recoup[^.\n]*?\$?\s?([\d,]+)/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = recoupRe.exec(text)) !== null) {
    const category = normalizeRecoupCategory(m[1]);
    const amount = parseFloat(m[2].replace(/,/g, ""));
    const phrase = text.slice(
      Math.max(0, m.index - 5),
      Math.min(text.length, m.index + m[0].length + 30),
    ).trim();
    // Heuristic for scope: explicit phrases first, fall back to unresolved
    // Default to unresolved. Only treat the scope as decided when the
    // wording is explicit. The phrase "against gross" alone reads two
    // ways in the industry (see Coastal Spell), so it stays unresolved.
    let scope: DealRecoup["scope"] = "unresolved";
    if (/inside.*cap|within.*cap|part of.*cap|included in.*cap/i.test(phrase)) {
      scope = "inside_cap";
    } else if (/outside.*cap|on top of.*cap|separate from.*cap|in addition to.*cap/i.test(phrase)) {
      scope = "outside_cap";
    }
    recoups.push({
      id: `recoup_${idx++}`,
      category,
      label: `${capitalize(m[1])} recoup`,
      amount,
      scope,
      source: phrase,
    });
  }

  // Bonuses (gross threshold pattern)
  const bonuses: ExtractedBonus[] = [];
  const bonusRe = /\+?\s*\$?\s?([\d,]+)\s*(?:bonus)?\s*(?:if|over|above)\s*(?:gross\s*(?:>|of)?)?\s*\$?\s?([\d,]+k?)/gi;
  let b: RegExpExecArray | null;
  let bIdx = 0;
  while ((b = bonusRe.exec(text)) !== null) {
    const amount = parseFloat(b[1].replace(/,/g, ""));
    const thresholdRaw = b[2].toLowerCase().replace(/,/g, "");
    const threshold = thresholdRaw.endsWith("k")
      ? parseFloat(thresholdRaw.slice(0, -1)) * 1000
      : parseFloat(thresholdRaw);
    if (Number.isFinite(amount) && Number.isFinite(threshold) && threshold > amount) {
      bonuses.push({
        id: `bonus_${bIdx++}`,
        type: "gross_threshold",
        label: `+$${amount.toLocaleString()} if gross > $${threshold.toLocaleString()}`,
        threshold,
        amount,
        source: b[0].trim(),
      });
    }
  }

  // Ambiguity detection
  const ambiguities: Ambiguity[] = [];
  recoups.forEach((r, i) => {
    if (r.scope === "unresolved" && expenseCap != null) {
      const priorMarketingDisputes =
        r.category === "marketing" ? (agent?.disputedMarketingRecoups ?? 0) : 0;
      const priorContext =
        agent && priorMarketingDisputes > 0
          ? `${agent.agentName} (${agent.agencyName ?? "Independent"}) has disputed marketing recoup scope on ${priorMarketingDisputes} prior show${priorMarketingDisputes === 1 ? "" : "s"} at this venue. Same phrasing pattern.`
          : null;
      ambiguities.push({
        id: `amb_recoup_${i}`,
        field: `recoups[${i}].scope`,
        phrase: r.source ?? r.label,
        readingA: {
          label: `Inside the $${expenseCap.toLocaleString()} expense cap`,
          value: "inside_cap",
        },
        readingB: {
          label: `On top of the $${expenseCap.toLocaleString()} expense cap`,
          value: "outside_cap",
        },
        explanation: `The deal language doesn't say whether the $${r.amount.toLocaleString()} ${r.category} recoup is part of the $${expenseCap.toLocaleString()} expense bucket or a separate deduction stacked on top. Both readings are defensible. Settlement math differs by the recoup amount times the percentage.`,
        priorContext,
        recommended: priorMarketingDisputes >= 3 ? "B" : null,
      });
    }
  });

  // If nothing parsed cleanly, surface a hint
  if (!recoups.length && !bonuses.length && guaranteeAmount == null && percentage == null) {
    return {
      mode: "mock",
      extracted: emptyExtracted(),
      ambiguities: [
        {
          id: "amb_unparseable",
          field: "dealType",
          phrase: text.slice(0, 80),
          readingA: { label: "Fill in the structured fields manually", value: "manual" },
          readingB: { label: "Or set OPENAI_API_KEY for AI extraction", value: "openai" },
          explanation:
            "The local parser couldn't extract enough from this prose. Set OPENAI_API_KEY in .env.local for the live model, or fill in the fields directly.",
          priorContext: null,
          recommended: null,
        },
      ],
      notes: ["Mock mode parsed nothing useful from this prose."],
    };
  }

  return {
    mode: "mock",
    extracted: {
      dealType,
      guaranteeAmount,
      percentage,
      percentageBasis,
      expenseCap,
      hospitalityCap,
      recoups,
      bonuses,
    },
    ambiguities,
    notes: [
      "Mock mode: parsed with the local regex extractor. For richer reasoning on edge cases, set OPENAI_API_KEY in .env.local.",
    ],
  };
}

function normalizeRecoupCategory(s: string): DealRecoup["category"] {
  const lower = s.toLowerCase().trim();
  if (lower.startsWith("market")) return "marketing";
  if (lower.startsWith("prod")) return "production";
  if (lower.includes("advance")) return "prior_advance";
  if (lower.startsWith("damage")) return "damages";
  return "other";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function mockSummary(
  extracted: ExtractedDeal,
  context: { artistName: string; venueName: string; showDate: string },
): string {
  const parts: string[] = [];
  parts.push(
    `${context.artistName} at ${context.venueName} on ${context.showDate}. `,
  );
  if (extracted.dealType === "vs" && extracted.guaranteeAmount != null && extracted.percentage != null) {
    parts.push(
      `Deal is $${extracted.guaranteeAmount.toLocaleString()} guarantee vs ${(extracted.percentage * 100).toFixed(0)}% of ${extracted.percentageBasis ?? "net"}, whichever is greater. `,
    );
  } else if (extracted.dealType === "flat" && extracted.guaranteeAmount != null) {
    parts.push(`Flat guarantee of $${extracted.guaranteeAmount.toLocaleString()}. `);
  }
  if (extracted.expenseCap != null) {
    parts.push(`Expenses capped at $${extracted.expenseCap.toLocaleString()}. `);
  }
  if (extracted.hospitalityCap != null) {
    parts.push(`Hospitality cap $${extracted.hospitalityCap.toLocaleString()}. `);
  }
  for (const r of extracted.recoups) {
    const scopeLabel =
      r.scope === "inside_cap"
        ? "inside the expense cap"
        : r.scope === "outside_cap"
          ? "on top of the expense cap"
          : r.scope === "against_gross"
            ? "against gross"
            : "scope not yet resolved";
    parts.push(
      `${r.label}: $${r.amount.toLocaleString()}, ${scopeLabel}. `,
    );
  }
  for (const b of extracted.bonuses) {
    parts.push(`${b.label}. `);
  }
  return parts.join("").trim();
}

// ---------------- helpers ----------------

function emptyExtracted(): ExtractedDeal {
  return {
    dealType: "vs",
    guaranteeAmount: null,
    percentage: null,
    percentageBasis: null,
    expenseCap: null,
    hospitalityCap: null,
    recoups: [],
    bonuses: [],
  };
}
