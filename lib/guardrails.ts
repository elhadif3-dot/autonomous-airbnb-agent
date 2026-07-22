import type { EditProposal, SupervisorOutput } from "@/lib/schemas";
import type { Review } from "@/lib/types";

export type GuardrailResult = {
  passed: boolean;
  violations: string[];
};

type EvidenceState = {
  listingId?: string;
  relevantReviews?: Review[];
  signals?: Array<{
    type: string;
    primaryEvidenceCount?: number;
  }>;
};

const forbiddenPatterns = [
  { name: "pricing", pattern: /\b(price|pricing|discount|rate|nightly|fee)\b/i },
  { name: "live_airbnb_access", pattern: /\b(live airbnb|airbnb account|real account|scrape|scraping)\b/i },
  { name: "private_messages", pattern: /\b(private message|inbox|guest message|dm)\b/i },
  { name: "review_replies", pattern: /\b(reply to review|respond to review|answer reviews)\b/i },
  { name: "unsupported_amenities", pattern: /\b(add pool|add gym|add parking|add air conditioning|add washer)\b/i }
];

export function validateProposal(proposal: EditProposal, state?: EvidenceState): GuardrailResult {
  const text = JSON.stringify(proposal);
  const violations = forbiddenPatterns
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.name);

  if (
    proposal.action === "prepare_edit_proposal" &&
    (!proposal.target_fields.includes("description") || !proposal.proposed_description_addition)
  ) {
    violations.push("invalid_edit_target");
  }

  if (proposal.action === "prepare_edit_proposal" && state) {
    const reviewsBelongToListing =
      !state.relevantReviews ||
      !state.listingId ||
      state.relevantReviews.every((review) => review.listingId === state.listingId);
    if (!reviewsBelongToListing) {
      violations.push("review_listing_mismatch");
    }

    const editableSignals = state.signals?.filter((signal) => signal.type !== "insufficient_evidence") ?? [];
    const strongestPrimaryEvidence = Math.max(
      ...editableSignals.map((signal) => signal.primaryEvidenceCount ?? 0),
      0
    );

    if (editableSignals.length === 0) {
      violations.push("no_editable_signal");
    }

    if (strongestPrimaryEvidence < 2) {
      violations.push("insufficient_primary_evidence");
    }
  }

  return {
    passed: violations.length === 0,
    violations
  };
}

export function enforceGuardrails(
  proposal: EditProposal,
  supervisor: SupervisorOutput,
  state?: EvidenceState
): SupervisorOutput {
  const validation = validateProposal(proposal, state);

  if (validation.passed) {
    return supervisor;
  }

  return {
    decision: "Block",
    rationale: `Blocked by guardrails: ${validation.violations.join(", ")}.`
  };
}
