"use client";

import { useState, useTransition } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Lock,
  Sparkles,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Field,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PlainBadge } from "@/components/ui/badge";
import { Logomark } from "@/components/brand/logo";
import { formatMoney } from "@/lib/format";
import { confirmDealAction, disputeDealAction } from "@/lib/dealActions";
import type { DealRecoup } from "@/db/schema";

type DealForReview = {
  dealType: string;
  guaranteeAmount: number | null;
  percentage: number | null;
  percentageBasis: string | null;
  expenseCap: number | null;
  hospitalityCap: number | null;
  recoups: DealRecoup[];
  bonuses: unknown[];
};

type Props = {
  token: string;
  status: string;
  artistName: string;
  agentName: string;
  agencyName: string | null;
  venueName: string;
  showDate: string;
  summary: string;
  deal: DealForReview;
};

const SCOPE_LABEL: Record<DealRecoup["scope"], string> = {
  inside_cap: "inside the expense cap",
  outside_cap: "on top of the expense cap",
  against_gross: "against gross",
  unresolved: "scope not yet resolved",
};

export default function AgentReviewClient({
  token,
  status: initialStatus,
  artistName,
  agentName,
  agencyName,
  venueName,
  showDate,
  summary,
  deal,
}: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [confirmPending, startConfirm] = useTransition();
  const [disputePending, startDispute] = useTransition();
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeNotes, setDisputeNotes] = useState("");

  const isLocked = status === "locked";

  function handleConfirm() {
    startConfirm(async () => {
      const result = await confirmDealAction(token);
      if (result.ok) setStatus("locked");
    });
  }

  function handleDispute() {
    if (!disputeNotes.trim()) return;
    startDispute(async () => {
      const result = await disputeDealAction(token, disputeNotes);
      if (result.ok) setStatus("disputed");
      setDisputeOpen(false);
    });
  }

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-3xl mx-auto px-8 py-12">
        {/* Header */}
        <div className="flex items-center gap-3 mb-10">
          <Logomark size={32} />
          <div>
            <div className="text-[12px] text-ink-500">Greenroom · Deal confirmation</div>
            <div className="text-[14px] font-medium text-ink-900">{venueName}</div>
          </div>
        </div>

        <div className="mb-8">
          <div className="eyebrow text-[10px] text-ink-500 mb-2">For {agentName}{agencyName ? ` · ${agencyName}` : ""}</div>
          <h1
            className="font-display text-[40px] font-medium text-ink-900 leading-[1.05]"
            style={{ letterSpacing: "-0.02em", fontOpticalSizing: "auto" }}
          >
            {artistName}
          </h1>
          <div className="text-[13px] text-ink-500 mt-2">{showDate}</div>
        </div>

        {/* Status banner */}
        {isLocked && (
          <div className="mb-8 rounded-lg ring-1 ring-brand-200/80 bg-brand-50/40 px-4 py-3 flex items-center gap-2">
            <Lock className="h-4 w-4 text-brand-700" />
            <div className="text-[13px] text-brand-900">
              Deal confirmed and locked. The settlement will run against these terms.
            </div>
          </div>
        )}
        {status === "disputed" && (
          <div className="mb-8 rounded-lg ring-1 ring-rose-200/80 bg-rose-50/40 px-4 py-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-700" />
            <div className="text-[13px] text-rose-900">
              You flagged this deal for revision. {venueName} has been notified.
            </div>
          </div>
        )}

        {/* AI summary */}
        <Card className="mb-6" accent="sky">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-sky-700" />
              <CardTitle>Plain-English summary</CardTitle>
            </div>
            <CardDescription>
              Generated from the structured fields below. If this doesn&apos;t match
              your reading of the original email, request a revision.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-[14px] text-ink-800 leading-relaxed">{summary}</p>
          </CardContent>
        </Card>

        {/* Structured deal */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Structured terms</CardTitle>
              <CardDescription>
                What the venue will calculate against on show night.
              </CardDescription>
            </div>
            <PlainBadge variant="default">{deal.dealType}</PlainBadge>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Field
                label="Guarantee"
                mono
                value={deal.guaranteeAmount != null ? formatMoney(deal.guaranteeAmount) : "—"}
              />
              <Field
                label="Percentage"
                mono
                value={
                  deal.percentage != null
                    ? `${(deal.percentage * 100).toFixed(0)}%${deal.percentageBasis ? ` of ${deal.percentageBasis}` : ""}`
                    : "—"
                }
              />
              <Field
                label="Expense cap"
                mono
                value={deal.expenseCap != null ? formatMoney(deal.expenseCap) : "—"}
              />
              <Field
                label="Hospitality cap"
                mono
                value={deal.hospitalityCap != null ? formatMoney(deal.hospitalityCap) : "—"}
              />
            </div>

            {deal.recoups.length > 0 && (
              <div className="mt-6">
                <div className="eyebrow text-[10px] text-ink-500 mb-2">Recoups</div>
                <div className="space-y-2">
                  {deal.recoups.map((r) => (
                    <div
                      key={r.id}
                      className="rounded-md ring-1 ring-ink-200/60 bg-canvas-soft px-3 py-2"
                    >
                      <div className="flex items-baseline justify-between">
                        <div className="text-[13px] text-ink-800">{r.label}</div>
                        <div className="text-[13px] font-mono tabular text-ink-700">
                          {formatMoney(r.amount)}
                        </div>
                      </div>
                      <div className="text-[11.5px] text-ink-500 mt-0.5">
                        {SCOPE_LABEL[r.scope]}
                      </div>
                      {r.source && (
                        <div className="text-[11px] text-ink-400 mt-1 italic">
                          From the email: &ldquo;{r.source}&rdquo;
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        {!isLocked && status !== "disputed" && (
          <div className="mt-10">
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="brand"
                size="lg"
                onClick={handleConfirm}
                disabled={confirmPending}
              >
                {confirmPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Confirm and lock
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => setDisputeOpen((v) => !v)}
              >
                <AlertTriangle className="h-4 w-4" />
                Request revision
              </Button>
            </div>

            {disputeOpen && (
              <div className="mt-4 rounded-lg ring-1 ring-ink-200/80 bg-white p-4">
                <div className="eyebrow text-[10px] text-ink-500 mb-2">
                  What needs to change?
                </div>
                <textarea
                  value={disputeNotes}
                  onChange={(e) => setDisputeNotes(e.target.value)}
                  className="w-full min-h-[100px] rounded-md border border-ink-200/80 bg-canvas-soft px-3 py-2 text-[13px] text-ink-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-700/40"
                  placeholder="The marketing recoup should be outside the expense cap, not inside."
                />
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="brand"
                    onClick={handleDispute}
                    disabled={disputePending || !disputeNotes.trim()}
                  >
                    {disputePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Send revision request
                  </Button>
                  <Button variant="ghost" onClick={() => setDisputeOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            <p className="mt-6 text-[11.5px] text-ink-400 leading-relaxed max-w-lg">
              Confirming locks both sides to this version of the deal. The venue will
              calculate settlement against these exact terms. If anything is off, request
              a revision instead.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
