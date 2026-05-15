"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Sparkles,
  AlertTriangle,
  Send,
  CheckCircle2,
  Copy,
  ExternalLink,
  Lock,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PlainBadge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import {
  extractDealAction,
  saveStructuredDealAction,
  sendToAgentAction,
  type SaveStructuredDealInput,
} from "@/lib/dealActions";
import type { ExtractedDeal, ExtractionResult, Ambiguity } from "@/lib/ai";
import type { DealRecoup, DeductionStep } from "@/db/schema";

type Props = {
  dealId: string;
  showId: string;
  artistName: string;
  agent: { agentName: string; agencyName: string | null } | null;
  initialProse: string;
  initialConfirmationStatus: string;
  initialToken: string | null;
  /**
   * If the deal has already been structured, hydrate the form with the
   * saved fields so a user visiting the page on a sent/locked deal sees
   * the agreed terms rather than an empty workspace.
   */
  initialStructured: ExtractedDeal | null;
};

const DEFAULT_DEDUCTION: DeductionStep[] = [
  "fees",
  "recoups_against_gross",
  "expenses_capped",
];

export default function StructureDealClient({
  dealId,
  showId,
  artistName,
  agent,
  initialProse,
  initialConfirmationStatus,
  initialToken,
  initialStructured,
}: Props) {
  const [prose, setProse] = useState(initialProse);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(
    initialStructured
      ? {
          mode: "mock",
          extracted: initialStructured,
          ambiguities: [],
          notes: ["Loaded from the saved structured deal."],
        }
      : null,
  );
  const [edited, setEdited] = useState<ExtractedDeal | null>(initialStructured);
  const [extractPending, startExtract] = useTransition();
  const [savePending, startSave] = useTransition();
  const [sendPending, startSend] = useTransition();
  const [status, setStatus] = useState(initialConfirmationStatus);
  const [token, setToken] = useState<string | null>(initialToken);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isLocked = status === "locked";
  const hasUnresolved = (edited?.recoups ?? []).some((r) => r.scope === "unresolved");

  function handleExtract() {
    setErrorMsg(null);
    startExtract(async () => {
      const result = await extractDealAction(showId, prose);
      setExtraction(result);
      setEdited(deepClone(result.extracted));
    });
  }

  function updateField<K extends keyof ExtractedDeal>(key: K, value: ExtractedDeal[K]) {
    if (!edited) return;
    setEdited({ ...edited, [key]: value });
  }

  function resolveAmbiguity(amb: Ambiguity, pick: "A" | "B") {
    if (!edited) return;
    const value = pick === "A" ? amb.readingA.value : amb.readingB.value;
    if (amb.field.startsWith("recoups[")) {
      const m = amb.field.match(/^recoups\[(\d+)\]\.(\w+)$/);
      if (!m) return;
      const idx = parseInt(m[1], 10);
      const subField = m[2];
      const newRecoups = edited.recoups.map((r, i) =>
        i === idx ? { ...r, [subField]: value } : r,
      );
      setEdited({ ...edited, recoups: newRecoups });
    }
  }

  function handleSave() {
    if (!edited) return;
    setErrorMsg(null);
    const input: SaveStructuredDealInput = {
      dealId,
      dealType: edited.dealType,
      guaranteeAmount: edited.guaranteeAmount,
      percentage: edited.percentage,
      percentageBasis: edited.percentageBasis,
      expenseCap: edited.expenseCap,
      hospitalityCap: edited.hospitalityCap,
      dealRecoups: edited.recoups,
      deductionOrder: DEFAULT_DEDUCTION,
      bonuses: edited.bonuses,
      dealNotesFreetext: prose,
    };
    startSave(async () => {
      const result = await saveStructuredDealAction(input);
      if (!result.ok) {
        setErrorMsg(result.reason);
        return;
      }
      setSavedAt(Date.now());
    });
  }

  function handleSendToAgent() {
    setErrorMsg(null);
    startSend(async () => {
      const result = await sendToAgentAction(dealId);
      if (!result.ok) {
        setErrorMsg(result.reason);
        return;
      }
      setToken(result.token);
      setStatus("sent_to_agent");
    });
  }

  const agentReviewUrl = token
    ? typeof window !== "undefined"
      ? `${window.location.origin}/agent-review/${token}`
      : `/agent-review/${token}`
    : null;

  return (
    <div className="px-12 py-10 max-w-7xl">
      <Link
        href={`/shows/${showId}`}
        className="inline-flex items-center gap-1 text-[12px] text-ink-400 hover:text-ink-900 mb-8 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to show
      </Link>

      <div className="mb-10">
        <div className="eyebrow mb-3">Structure deal</div>
        <h1
          className="font-display text-[44px] font-medium text-ink-900 leading-[1.05]"
          style={{ letterSpacing: "-0.02em", fontOpticalSizing: "auto" }}
        >
          {artistName}
        </h1>
        <p className="text-[14px] text-ink-500 mt-3 max-w-2xl leading-relaxed">
          Paste the agent&apos;s deal email. AI pulls the terms into structured fields and
          flags any ambiguous clauses that need to be resolved before the deal is sent
          to {agent?.agentName ?? "the agent"}{agent?.agencyName ? ` at ${agent.agencyName}` : ""} for confirmation.
        </p>
      </div>

      {/* Status strip */}
      <div className="mb-8 flex items-center gap-2">
        <StatusPill status={status} />
        {isLocked && (
          <span className="text-[12px] text-ink-500">
            Deal is locked. Both parties have signed off.
          </span>
        )}
        {status === "sent_to_agent" && agentReviewUrl && (
          <span className="text-[12px] text-ink-500">
            Awaiting agent confirmation. Magic link below.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: prose + extract */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Deal email prose</CardTitle>
              <CardDescription>
                Paste the agent&apos;s email exactly as it arrived. AI extracts into the
                structured form on the right.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full min-h-[280px] rounded-md border border-ink-200/80 bg-canvas-soft px-3 py-2.5 text-[13px] font-mono text-ink-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-700/40 focus:border-brand-400"
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              disabled={isLocked}
              placeholder="$5,000 vs 80% of net after expenses..."
            />
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="brand"
                onClick={handleExtract}
                disabled={extractPending || !prose.trim() || isLocked}
              >
                {extractPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {extraction ? "Re-extract" : "Extract with AI"}
              </Button>
              {extraction && (
                <span className="text-[11.5px] text-ink-400 font-mono">
                  {extraction.mode === "live" ? "live · gpt-4.1-mini" : "mock mode · set OPENAI_API_KEY"}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Right: structured form */}
        <Card accent={hasUnresolved ? "amber" : extraction ? "brand" : undefined}>
          <CardHeader>
            <div>
              <CardTitle>Structured deal</CardTitle>
              <CardDescription>
                Mariana&apos;s confirmed reading. This is what the calculator runs
                against and what the agent signs.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {edited ? (
              <StructuredForm
                edited={edited}
                onChange={setEdited}
                onUpdate={updateField}
                disabled={isLocked}
              />
            ) : (
              <div className="py-10 text-center text-[13px] text-ink-400">
                Paste the deal email and click <em>Extract</em>. The structured fields
                populate here.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Ambiguities */}
      {extraction && extraction.ambiguities.length > 0 && edited && (
        <div className="mt-8 space-y-4">
          <h2
            className="font-display text-[22px] font-medium text-ink-900"
            style={{ letterSpacing: "-0.02em" }}
          >
            Resolve before sending
          </h2>
          {extraction.ambiguities.map((amb) => (
            <AmbiguityCard
              key={amb.id}
              ambiguity={amb}
              edited={edited}
              onResolve={(pick) => resolveAmbiguity(amb, pick)}
              disabled={isLocked}
            />
          ))}
        </div>
      )}

      {/* Save + send */}
      {edited && (
        <div className="mt-10 pt-8 border-t border-ink-200/60">
          <div className="flex items-center gap-3 flex-wrap">
            {!isLocked && (
              <Button
                variant="brand"
                size="lg"
                onClick={handleSave}
                disabled={savePending || hasUnresolved}
              >
                {savePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Save structured deal
              </Button>
            )}
            {!isLocked && (
              <Button
                variant="secondary"
                size="lg"
                onClick={handleSendToAgent}
                disabled={sendPending || hasUnresolved || savedAt == null}
              >
                {sendPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send to agent for confirmation
              </Button>
            )}
            {hasUnresolved && (
              <span className="text-[12px] text-amber-700 inline-flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" /> Resolve every ambiguity first.
              </span>
            )}
            {savedAt && !sendPending && status === "draft" && (
              <span className="text-[12px] text-brand-700 inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved.
              </span>
            )}
          </div>

          {errorMsg && (
            <div className="mt-4 rounded-md ring-1 ring-rose-200/80 bg-rose-50/40 px-4 py-2.5 text-[12.5px] text-rose-800">
              {errorMsg}
            </div>
          )}
        </div>
      )}

      {/* Agent review magic link */}
      {agentReviewUrl && status !== "draft" && (
        <Card className="mt-8" accent={isLocked ? "brand" : "sky"}>
          <CardHeader>
            <div>
              <CardTitle>
                {isLocked ? "Deal locked" : "Agent review link"}
              </CardTitle>
              <CardDescription>
                {isLocked
                  ? "Both parties have signed off. The settlement worksheet will run against this locked version."
                  : "Send this link to the agent. They review the structured deal alongside an AI-generated plain-English summary, then confirm or push back."}
              </CardDescription>
            </div>
            {isLocked && <Lock className="h-4 w-4 text-brand-700" />}
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-md bg-canvas-soft ring-1 ring-ink-200/60 px-3 py-2">
              <code className="text-[12px] font-mono text-ink-700 truncate flex-1">
                {agentReviewUrl}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(agentReviewUrl)}
              >
                <Copy className="h-3 w-3" /> Copy
              </Button>
              <Link href={`/agent-review/${token}`} target="_blank">
                <Button variant="secondary" size="sm">
                  <ExternalLink className="h-3 w-3" /> Open
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------- subcomponents ----------------

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    draft: { label: "Draft", tone: "bg-ink-100 text-ink-700 ring-ink-200" },
    sent_to_agent: { label: "Sent to agent", tone: "bg-sky-50 text-sky-800 ring-sky-200" },
    viewed: { label: "Agent viewing", tone: "bg-sky-50 text-sky-800 ring-sky-200" },
    confirmed: { label: "Confirmed", tone: "bg-brand-50 text-brand-800 ring-brand-200" },
    disputed: { label: "Disputed", tone: "bg-rose-50 text-rose-800 ring-rose-200" },
    locked: { label: "Locked", tone: "bg-brand-50 text-brand-800 ring-brand-200" },
  };
  const c = map[status] ?? map.draft;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ring-1 ring-inset ${c.tone}`}>
      {c.label}
    </span>
  );
}

function StructuredForm({
  edited,
  onChange,
  onUpdate,
  disabled,
}: {
  edited: ExtractedDeal;
  onChange: (next: ExtractedDeal) => void;
  onUpdate: <K extends keyof ExtractedDeal>(k: K, v: ExtractedDeal[K]) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Labeled label="Deal type">
          <select
            className="w-full rounded-md border border-ink-200/80 bg-white px-2.5 py-1.5 text-[12.5px] text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-700/40"
            value={edited.dealType}
            onChange={(e) => onUpdate("dealType", e.target.value as ExtractedDeal["dealType"])}
            disabled={disabled}
          >
            <option value="vs">vs (guarantee vs %)</option>
            <option value="flat">flat</option>
            <option value="percentage_of_gross">% of gross</option>
            <option value="percentage_of_net">% of net</option>
            <option value="door">door</option>
          </select>
        </Labeled>
        <Labeled label="Percentage basis">
          <select
            className="w-full rounded-md border border-ink-200/80 bg-white px-2.5 py-1.5 text-[12.5px] text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-700/40"
            value={edited.percentageBasis ?? ""}
            onChange={(e) => onUpdate("percentageBasis", (e.target.value || null) as ExtractedDeal["percentageBasis"])}
            disabled={disabled}
          >
            <option value="">—</option>
            <option value="gross">gross</option>
            <option value="net">net</option>
          </select>
        </Labeled>
        <Labeled label="Guarantee ($)">
          <NumberInput
            value={edited.guaranteeAmount}
            onChange={(v) => onUpdate("guaranteeAmount", v)}
            disabled={disabled}
          />
        </Labeled>
        <Labeled label="Percentage (0-1)">
          <NumberInput
            value={edited.percentage}
            onChange={(v) => onUpdate("percentage", v)}
            step={0.05}
            disabled={disabled}
          />
        </Labeled>
        <Labeled label="Expense cap ($)">
          <NumberInput
            value={edited.expenseCap}
            onChange={(v) => onUpdate("expenseCap", v)}
            disabled={disabled}
          />
        </Labeled>
        <Labeled label="Hospitality cap ($)">
          <NumberInput
            value={edited.hospitalityCap}
            onChange={(v) => onUpdate("hospitalityCap", v)}
            disabled={disabled}
          />
        </Labeled>
      </div>

      {/* Recoups */}
      <div>
        <div className="eyebrow text-[10px] text-ink-500 mb-2">Recoups (deal-level)</div>
        {edited.recoups.length === 0 ? (
          <div className="text-[12px] text-ink-400 italic">No recoups on this deal.</div>
        ) : (
          <div className="space-y-2">
            {edited.recoups.map((r, idx) => (
              <RecoupRow
                key={r.id}
                recoup={r}
                onChange={(next) => {
                  const newRecoups = edited.recoups.map((x, i) => (i === idx ? next : x));
                  onChange({ ...edited, recoups: newRecoups });
                }}
                disabled={disabled}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bonuses */}
      {edited.bonuses.length > 0 && (
        <div>
          <div className="eyebrow text-[10px] text-ink-500 mb-2">Bonuses</div>
          <div className="space-y-1">
            {edited.bonuses.map((b) => (
              <div
                key={b.id}
                className="text-[12.5px] text-ink-700 bg-canvas-soft rounded-md px-3 py-1.5 ring-1 ring-ink-200/60"
              >
                {b.label}
                {b.amount != null && (
                  <span className="ml-1.5 text-ink-400 font-mono">
                    ({formatMoney(b.amount)})
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecoupRow({
  recoup,
  onChange,
  disabled,
}: {
  recoup: DealRecoup;
  onChange: (next: DealRecoup) => void;
  disabled: boolean;
}) {
  const isUnresolved = recoup.scope === "unresolved";
  return (
    <div className={`rounded-md px-3 py-2 ring-1 ${isUnresolved ? "bg-amber-50/40 ring-amber-200" : "bg-canvas-soft ring-ink-200/60"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[12.5px] text-ink-800">{recoup.label}</div>
        <div className="text-[12.5px] font-mono tabular text-ink-700">
          {formatMoney(recoup.amount)}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px]">
        <span className="text-ink-500">scope:</span>
        <select
          className="rounded border border-ink-200/80 bg-white px-1.5 py-0.5 text-[11px] text-ink-800"
          value={recoup.scope}
          onChange={(e) => onChange({ ...recoup, scope: e.target.value as DealRecoup["scope"] })}
          disabled={disabled}
        >
          <option value="unresolved">unresolved</option>
          <option value="inside_cap">inside expense cap</option>
          <option value="outside_cap">outside expense cap</option>
          <option value="against_gross">against gross</option>
        </select>
        {recoup.source && (
          <span className="text-ink-400 italic truncate flex-1" title={recoup.source}>
            &ldquo;{recoup.source}&rdquo;
          </span>
        )}
      </div>
    </div>
  );
}

function AmbiguityCard({
  ambiguity,
  edited,
  onResolve,
  disabled,
}: {
  ambiguity: Ambiguity;
  edited: ExtractedDeal;
  onResolve: (pick: "A" | "B") => void;
  disabled: boolean;
}) {
  const isResolved =
    !ambiguity.field.startsWith("recoups[") ||
    !(edited.recoups.find((r, i) => `recoups[${i}].scope` === ambiguity.field)?.scope === "unresolved");

  return (
    <Card accent={isResolved ? "brand" : "amber"}>
      <CardHeader>
        <div className="flex items-center gap-2">
          {isResolved ? (
            <CheckCircle2 className="h-4 w-4 text-brand-700" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-700" />
          )}
          <CardTitle>{isResolved ? "Resolved" : "Ambiguous clause"}</CardTitle>
        </div>
        {ambiguity.priorContext && <PlainBadge variant="amber">grounded</PlainBadge>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="eyebrow text-[10px] text-ink-500 mb-1.5">From the prose</div>
          <div className="text-[13px] text-ink-800 bg-canvas-soft rounded-md px-3 py-2 ring-1 ring-ink-200/60 italic">
            &ldquo;{ambiguity.phrase}&rdquo;
          </div>
        </div>
        <div className="text-[12.5px] text-ink-600 leading-relaxed">{ambiguity.explanation}</div>
        {ambiguity.priorContext && (
          <div className="rounded-md ring-1 ring-amber-200/60 bg-amber-50/40 px-3 py-2 text-[12px] text-amber-900 leading-relaxed">
            <strong>Pattern detected:</strong> {ambiguity.priorContext}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <ResolveButton
            label={ambiguity.readingA.label}
            recommended={ambiguity.recommended === "A"}
            disabled={disabled}
            onClick={() => onResolve("A")}
          />
          <ResolveButton
            label={ambiguity.readingB.label}
            recommended={ambiguity.recommended === "B"}
            disabled={disabled}
            onClick={() => onResolve("B")}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ResolveButton({
  label,
  recommended,
  disabled,
  onClick,
}: {
  label: string;
  recommended?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`relative text-left rounded-md px-3.5 py-2.5 text-[12.5px] leading-relaxed transition ring-1 ${
        recommended
          ? "bg-brand-50 ring-brand-300 text-brand-900 hover:bg-brand-100"
          : "bg-white ring-ink-200/80 text-ink-800 hover:bg-canvas-soft"
      } disabled:opacity-50 disabled:cursor-not-allowed`}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
      {recommended && (
        <span className="absolute top-1 right-2 text-[9px] uppercase font-semibold tracking-wider text-brand-700">
          recommended
        </span>
      )}
    </button>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow text-[10px] text-ink-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  step = 1,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      className="w-full rounded-md border border-ink-200/80 bg-white px-2.5 py-1.5 text-[12.5px] font-mono tabular text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-700/40"
      value={value ?? ""}
      step={step}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? null : Number(v));
      }}
      disabled={disabled}
    />
  );
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}
