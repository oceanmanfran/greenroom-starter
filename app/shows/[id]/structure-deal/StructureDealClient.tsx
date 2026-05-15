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
  Plus,
  X,
  Eye,
  Unlock,
  RefreshCw,
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
import type { ExtractedDeal, ExtractionResult, Ambiguity, ExtractedBonus } from "@/lib/ai";
import type { DealRecoup, DeductionStep } from "@/db/schema";

type Props = {
  dealId: string;
  showId: string;
  artistName: string;
  agent: { agentName: string; agencyName: string | null } | null;
  initialProse: string;
  initialConfirmationStatus: string;
  initialToken: string | null;
  initialStructured: ExtractedDeal | null;
  initialViewedAt: string | null;
  initialConfirmedAt: string | null;
  initialAgentNotes: string | null;
};

const DEFAULT_DEDUCTION: DeductionStep[] = [
  "fees",
  "recoups_against_gross",
  "expenses_capped",
];

function emptyExtracted(): ExtractedDeal {
  return {
    dealType: "vs",
    guaranteeAmount: null,
    percentage: null,
    percentageBasis: "net",
    expenseCap: null,
    hospitalityCap: null,
    recoups: [],
    bonuses: [],
  };
}

function newRecoupId() {
  return `recoup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function StructureDealClient({
  dealId,
  showId,
  artistName,
  agent,
  initialProse,
  initialConfirmationStatus,
  initialToken,
  initialStructured,
  initialViewedAt,
  initialConfirmedAt,
  initialAgentNotes,
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
  // Always start with a usable form so manual entry works without running Extract.
  const [edited, setEdited] = useState<ExtractedDeal>(
    initialStructured ?? emptyExtracted(),
  );
  const [extractPending, startExtract] = useTransition();
  const [savePending, startSave] = useTransition();
  const [sendPending, startSend] = useTransition();
  const [status, setStatus] = useState(initialConfirmationStatus);
  const [token, setToken] = useState<string | null>(initialToken);
  const [savedAt, setSavedAt] = useState<number | null>(
    initialStructured ? Date.now() - 1 : null,
  );
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [editingLocked, setEditingLocked] = useState(false);

  const isLocked = status === "locked" && !editingLocked;
  const isDisputed = status === "disputed";
  const hasUnresolved = (edited?.recoups ?? []).some((r) => r.scope === "unresolved");
  const dealLooksEmpty =
    edited.guaranteeAmount == null &&
    edited.percentage == null &&
    edited.recoups.length === 0 &&
    edited.bonuses.length === 0;

  function setEditedAndMark(next: ExtractedDeal) {
    setEdited(next);
    setHasUnsavedChanges(true);
  }

  function handleExtract() {
    setErrorMsg(null);
    const proceed = () => {
      startExtract(async () => {
        const result = await extractDealAction(showId, prose);
        setExtraction(result);
        setEdited(deepClone(result.extracted));
        setHasUnsavedChanges(true);
      });
    };
    if (hasUnsavedChanges) {
      const ok = window.confirm(
        "Re-extracting will replace your current form values with a fresh AI extraction. Continue?",
      );
      if (!ok) return;
    }
    proceed();
  }

  function updateField<K extends keyof ExtractedDeal>(key: K, value: ExtractedDeal[K]) {
    setEditedAndMark({ ...edited, [key]: value });
  }

  function resolveAmbiguity(amb: Ambiguity, pick: "A" | "B") {
    const value = pick === "A" ? amb.readingA.value : amb.readingB.value;
    if (amb.field.startsWith("recoups[")) {
      const m = amb.field.match(/^recoups\[(\d+)\]\.(\w+)$/);
      if (!m) return;
      const idx = parseInt(m[1], 10);
      const subField = m[2];
      const newRecoups = edited.recoups.map((r, i) =>
        i === idx ? { ...r, [subField]: value } : r,
      );
      setEditedAndMark({ ...edited, recoups: newRecoups });
    }
  }

  function addRecoup() {
    const next: DealRecoup = {
      id: newRecoupId(),
      category: "marketing",
      label: "",
      amount: 0,
      scope: "unresolved",
      source: null,
    };
    setEditedAndMark({ ...edited, recoups: [...edited.recoups, next] });
  }

  function removeRecoup(idx: number) {
    setEditedAndMark({
      ...edited,
      recoups: edited.recoups.filter((_, i) => i !== idx),
    });
  }

  function removeBonus(idx: number) {
    setEditedAndMark({
      ...edited,
      bonuses: edited.bonuses.filter((_, i) => i !== idx),
    });
  }

  function validateBeforeSave(): string | null {
    if (edited.dealType === "vs") {
      if (edited.guaranteeAmount == null && edited.percentage == null) {
        return "A Vs deal needs at least a guarantee or a percentage. Right now it has neither.";
      }
    }
    if (edited.dealType === "flat" && edited.guaranteeAmount == null) {
      return "Flat deal needs a guarantee amount.";
    }
    if (
      (edited.dealType === "percentage_of_gross" || edited.dealType === "percentage_of_net") &&
      edited.percentage == null
    ) {
      return `A ${edited.dealType.replace(/_/g, " ")} deal needs a percentage.`;
    }
    if (edited.percentage != null && (edited.percentage < 0 || edited.percentage > 1)) {
      return "Percentage must be between 0 and 1 (e.g. 0.8 for 80%).";
    }
    for (const r of edited.recoups) {
      if (!r.label.trim()) return "Every recoup needs a label.";
      if (r.amount < 0) return `Recoup "${r.label}" has a negative amount.`;
    }
    return null;
  }

  function handleSave() {
    setErrorMsg(null);
    const err = validateBeforeSave();
    if (err) {
      setErrorMsg(err);
      return;
    }
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
      setHasUnsavedChanges(false);
      if (result.resetFromLocked) {
        setStatus("draft");
        setToken(null);
        setEditingLocked(false);
        setErrorMsg(
          "Saved. The deal was unlocked because you amended a previously-confirmed version. Re-send to agent to lock again.",
        );
      } else if (result.newStatus !== status) {
        setStatus(result.newStatus);
      }
    });
  }

  function handleSendToAgent() {
    setErrorMsg(null);
    if (hasUnsavedChanges) {
      setErrorMsg("Save your changes before sending to the agent.");
      return;
    }
    startSend(async () => {
      const result = await sendToAgentAction(dealId);
      if (!result.ok) {
        setErrorMsg(result.reason);
        return;
      }
      setToken(result.token);
      setStatus("sent_to_agent");
      setEditingLocked(false);
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
          Paste the agent&apos;s deal email and let AI extract the terms, or fill the
          structured form directly. Either way the deal locks only after{" "}
          {agent?.agentName ?? "the agent"}
          {agent?.agencyName ? ` at ${agent.agencyName}` : ""} confirms it.
        </p>
      </div>

      {/* Status strip */}
      <div className="mb-8 flex items-center gap-2 flex-wrap">
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
        {status === "viewed" && (
          <span className="text-[12px] text-ink-500">
            Agent has opened the link, hasn&apos;t confirmed yet.
          </span>
        )}
        {isDisputed && (
          <span className="text-[12px] text-rose-700">
            Agent flagged the deal for revision.
          </span>
        )}
        {!isLocked && hasUnsavedChanges && status === "draft" && (
          <span className="text-[12px] text-amber-700 inline-flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> Unsaved changes
          </span>
        )}
        {status === "locked" && (
          <Button
            variant={editingLocked ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setEditingLocked((v) => !v)}
          >
            {editingLocked ? (
              <>
                <Lock className="h-3 w-3" /> Lock again
              </>
            ) : (
              <>
                <Unlock className="h-3 w-3" /> Amend (re-send to agent)
              </>
            )}
          </Button>
        )}
      </div>

      {/* Agent dispute callout */}
      {isDisputed && initialAgentNotes && (
        <Card className="mb-8" accent="rose">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-700" />
              <CardTitle>Agent requested a revision</CardTitle>
            </div>
            <CardDescription>
              From {agent?.agentName ?? "the agent"}. Update the structured deal
              and re-send to clear the dispute.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-[13px] text-ink-800 bg-canvas-soft rounded-md px-3 py-2 ring-1 ring-ink-200/60 leading-relaxed">
              &ldquo;{initialAgentNotes}&rdquo;
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: prose + extract */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Deal email prose</CardTitle>
              <CardDescription>
                Paste the agent&apos;s email exactly as it arrived. Optional. The
                structured form on the right also works on its own for deals you got
                over the phone or already know cold.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full min-h-[280px] rounded-md border border-ink-200/80 bg-canvas-soft px-3 py-2.5 text-[13px] font-mono text-ink-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-700/40 focus:border-brand-400"
              value={prose}
              onChange={(e) => {
                setProse(e.target.value);
                setHasUnsavedChanges(true);
              }}
              disabled={isLocked}
              placeholder="$5,000 vs 80% of net after expenses..."
            />
            <div className="mt-3 flex items-center gap-2 flex-wrap">
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
            {extraction?.notes?.length ? (
              <div className="mt-3 text-[11.5px] text-ink-500 leading-relaxed">
                {extraction.notes.map((n, i) => (
                  <div key={i}>• {n}</div>
                ))}
              </div>
            ) : null}
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
            {dealLooksEmpty && !isLocked && (
              <PlainBadge variant="default">empty</PlainBadge>
            )}
          </CardHeader>
          <CardContent>
            <StructuredForm
              edited={edited}
              onChange={setEditedAndMark}
              onUpdate={updateField}
              onAddRecoup={addRecoup}
              onRemoveRecoup={removeRecoup}
              onRemoveBonus={removeBonus}
              disabled={isLocked}
            />
          </CardContent>
        </Card>
      </div>

      {/* Ambiguities */}
      {extraction && extraction.ambiguities.length > 0 && (
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
      <div className="mt-10 pt-8 border-t border-ink-200/60">
        <div className="flex items-center gap-3 flex-wrap">
          {!isLocked && (
            <Button
              variant="brand"
              size="lg"
              onClick={handleSave}
              disabled={savePending || hasUnresolved || dealLooksEmpty}
            >
              {savePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {savedAt ? "Update structured deal" : "Save structured deal"}
            </Button>
          )}
          {!isLocked && (
            <Button
              variant="secondary"
              size="lg"
              onClick={handleSendToAgent}
              disabled={sendPending || hasUnresolved || savedAt == null || hasUnsavedChanges}
            >
              {sendPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {status === "draft" ? "Send to agent for confirmation" : "Re-send to agent"}
            </Button>
          )}
          {hasUnresolved && (
            <span className="text-[12px] text-amber-700 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Resolve every ambiguity first.
            </span>
          )}
          {dealLooksEmpty && !isLocked && (
            <span className="text-[12px] text-ink-400 inline-flex items-center gap-1.5">
              Fill in the structured fields (or paste & extract) to save.
            </span>
          )}
          {savedAt && !sendPending && !hasUnsavedChanges && status === "draft" && (
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

      {/* Agent review magic link */}
      {agentReviewUrl && status !== "draft" && (
        <Card className="mt-8" accent={isLocked ? "brand" : status === "disputed" ? "rose" : "sky"}>
          <CardHeader>
            <div>
              <CardTitle>
                {isLocked
                  ? "Deal locked"
                  : status === "disputed"
                    ? "Awaiting your revision"
                    : "Agent review link"}
              </CardTitle>
              <CardDescription>
                {isLocked
                  ? "Both parties have signed off. The settlement worksheet will run against this locked version."
                  : status === "disputed"
                    ? "The agent flagged a problem. Update the structured deal and re-send to issue a fresh link."
                    : "Send this link to the agent. They review the structured deal alongside an AI-generated plain-English summary, then confirm or push back."}
              </CardDescription>
            </div>
            {isLocked && <Lock className="h-4 w-4 text-brand-700" />}
          </CardHeader>
          <CardContent className="space-y-3">
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
            <div className="flex items-center gap-4 text-[11.5px] text-ink-500 flex-wrap">
              {initialViewedAt && (
                <span className="inline-flex items-center gap-1">
                  <Eye className="h-3 w-3" /> Viewed {formatRelative(initialViewedAt)}
                </span>
              )}
              {initialConfirmedAt && (
                <span className="inline-flex items-center gap-1 text-brand-700">
                  <CheckCircle2 className="h-3 w-3" /> Confirmed {formatRelative(initialConfirmedAt)}
                </span>
              )}
              <Link
                href={`/shows/${showId}/structure-deal`}
                className="inline-flex items-center gap-1 text-ink-500 hover:text-ink-900"
              >
                <RefreshCw className="h-3 w-3" /> Refresh status
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
  onAddRecoup,
  onRemoveRecoup,
  onRemoveBonus,
  disabled,
}: {
  edited: ExtractedDeal;
  onChange: (next: ExtractedDeal) => void;
  onUpdate: <K extends keyof ExtractedDeal>(k: K, v: ExtractedDeal[K]) => void;
  onAddRecoup: () => void;
  onRemoveRecoup: (idx: number) => void;
  onRemoveBonus: (idx: number) => void;
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
            min={0}
            disabled={disabled}
          />
        </Labeled>
        <Labeled label="Percentage (0-1)">
          <NumberInput
            value={edited.percentage}
            onChange={(v) => onUpdate("percentage", v)}
            step={0.05}
            min={0}
            max={1}
            disabled={disabled}
          />
        </Labeled>
        <Labeled label="Expense cap ($)">
          <NumberInput
            value={edited.expenseCap}
            onChange={(v) => onUpdate("expenseCap", v)}
            min={0}
            disabled={disabled}
          />
        </Labeled>
        <Labeled label="Hospitality cap ($)">
          <NumberInput
            value={edited.hospitalityCap}
            onChange={(v) => onUpdate("hospitalityCap", v)}
            min={0}
            disabled={disabled}
          />
        </Labeled>
      </div>

      {/* Recoups */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="eyebrow text-[10px] text-ink-500">Recoups (deal-level)</div>
          {!disabled && (
            <Button variant="ghost" size="sm" onClick={onAddRecoup}>
              <Plus className="h-3 w-3" /> Add recoup
            </Button>
          )}
        </div>
        {edited.recoups.length === 0 ? (
          <div className="text-[12px] text-ink-400 italic">
            No recoups on this deal. {disabled ? "" : "Click “Add recoup” if the agent wants any costs taken off the top."}
          </div>
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
                onRemove={() => onRemoveRecoup(idx)}
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
            {edited.bonuses.map((b, idx) => (
              <BonusRow
                key={b.id}
                bonus={b}
                onRemove={() => onRemoveBonus(idx)}
                disabled={disabled}
              />
            ))}
          </div>
          <div className="text-[10.5px] text-ink-400 mt-2 leading-snug">
            Bonuses can be removed but not edited inline yet. Re-extract from the
            prose to capture amended bonus structures.
          </div>
        </div>
      )}
    </div>
  );
}

function RecoupRow({
  recoup,
  onChange,
  onRemove,
  disabled,
}: {
  recoup: DealRecoup;
  onChange: (next: DealRecoup) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const isUnresolved = recoup.scope === "unresolved";
  return (
    <div className={`rounded-md px-3 py-2 ring-1 ${isUnresolved ? "bg-amber-50/40 ring-amber-200" : "bg-canvas-soft ring-ink-200/60"}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 grid grid-cols-[1fr_auto_auto] gap-2 items-baseline">
          <input
            type="text"
            className="rounded border border-ink-200/80 bg-white px-2 py-1 text-[12.5px] text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-700/40"
            value={recoup.label}
            onChange={(e) => onChange({ ...recoup, label: e.target.value })}
            placeholder="Marketing recoup, hospitality overage, etc."
            disabled={disabled}
          />
          <select
            className="rounded border border-ink-200/80 bg-white px-2 py-1 text-[12.5px] text-ink-800"
            value={recoup.category}
            onChange={(e) => onChange({ ...recoup, category: e.target.value as DealRecoup["category"] })}
            disabled={disabled}
          >
            <option value="marketing">marketing</option>
            <option value="production">production</option>
            <option value="prior_advance">prior advance</option>
            <option value="damages">damages</option>
            <option value="other">other</option>
          </select>
          <input
            type="number"
            className="w-24 rounded border border-ink-200/80 bg-white px-2 py-1 text-[12.5px] font-mono tabular text-ink-800 text-right focus:outline-none focus:ring-2 focus:ring-brand-700/40"
            value={recoup.amount}
            min={0}
            step={1}
            onChange={(e) => onChange({ ...recoup, amount: Number(e.target.value) || 0 })}
            disabled={disabled}
          />
        </div>
        {!disabled && (
          <button
            type="button"
            onClick={onRemove}
            className="text-ink-400 hover:text-rose-700 transition-colors"
            aria-label="Remove recoup"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
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

function BonusRow({
  bonus,
  onRemove,
  disabled,
}: {
  bonus: ExtractedBonus;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-ink-700 bg-canvas-soft rounded-md px-3 py-1.5 ring-1 ring-ink-200/60">
      <span className="flex-1 truncate">
        {bonus.label}
        {bonus.amount != null && (
          <span className="ml-1.5 text-ink-400 font-mono">({formatMoney(bonus.amount)})</span>
        )}
      </span>
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          className="text-ink-400 hover:text-rose-700"
          aria-label="Remove bonus"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
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
  min,
  max,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      className="w-full rounded-md border border-ink-200/80 bg-white px-2.5 py-1.5 text-[12.5px] font-mono tabular text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-700/40"
      value={value ?? ""}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(null);
        let n = Number(raw);
        if (Number.isNaN(n)) return onChange(null);
        if (min != null && n < min) n = min;
        if (max != null && n > max) n = max;
        onChange(n);
      }}
      disabled={disabled}
    />
  );
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
