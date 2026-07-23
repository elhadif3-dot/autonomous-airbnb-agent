import type { EditProposal, SupervisorOutput } from "@/lib/schemas";
import type { Review } from "@/lib/types";

export type GuardrailResult = {
  passed: boolean;
  violations: string[];
};

type EvidenceState = {
  listingId?: string;
  page?: {
    currentDescription?: string;
  };
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
  const editText = [
    proposal.proposed_description_addition,
    proposal.proposed_description_replacement
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const currentDescription = state?.page?.currentDescription;
  const violations = forbiddenPatterns
    .filter((rule) => {
      if (!rule.pattern.test(editText)) {
        return false;
      }

      return !(proposal.action === "replace_description" && currentDescription && rule.pattern.test(currentDescription));
    })
    .map((rule) => rule.name);

  if (
    proposal.action === "prepare_edit_proposal" &&
    (!proposal.target_fields.includes("description") || !proposal.proposed_description_addition)
  ) {
    violations.push("invalid_edit_target");
  }

  if (
    proposal.action === "replace_description" &&
    (!proposal.target_fields.includes("description") || !proposal.proposed_description_replacement)
  ) {
    violations.push("invalid_replacement_target");
  }

  if (proposal.action === "restore_previous_page" && !proposal.target_fields.includes("description")) {
    violations.push("invalid_restore_target");
  }

  if (proposal.action === "restore_original_page" && !proposal.target_fields.includes("description")) {
    violations.push("invalid_restore_target");
  }

  if ((proposal.action === "prepare_edit_proposal" || proposal.action === "replace_description") && state) {
    const reviewsBelongToListing =
      !state.relevantReviews ||
      !state.listingId ||
      state.relevantReviews.every((review) => review.listingId === state.listingId);
    if (!reviewsBelongToListing) {
      violations.push("review_listing_mismatch");
    }

    const isCopyPolish = proposal.evidence_topics?.includes("Copy polish only") ?? false;
    const editableSignals = state.signals?.filter((signal) => signal.type !== "insufficient_evidence") ?? [];
    const strongestPrimaryEvidence = Math.max(
      ...editableSignals.map((signal) => signal.primaryEvidenceCount ?? 0),
      0
    );

    if (!isCopyPolish && editableSignals.length === 0) {
      violations.push("no_editable_signal");
    }

    if (!isCopyPolish && strongestPrimaryEvidence < 2) {
      violations.push("insufficient_primary_evidence");
    }

    if (
      currentDescription &&
      proposal.proposed_description_addition &&
      normalizedText(currentDescription).includes(normalizedText(proposal.proposed_description_addition))
    ) {
      violations.push("no_effective_page_change");
    }

    if (
      currentDescription &&
      proposal.proposed_description_replacement &&
      normalizedText(currentDescription) === normalizedText(proposal.proposed_description_replacement)
    ) {
      violations.push("no_effective_page_change");
    }

    if (
      currentDescription &&
      proposal.proposed_description_replacement &&
      !preservesProtectedFacts(currentDescription, proposal.proposed_description_replacement)
    ) {
      violations.push("protected_fact_removed_or_changed");
    }
  }

  return {
    passed: violations.length === 0,
    violations
  };
}

function preservesProtectedFacts(before: string, after: string): boolean {
  const normalizedAfter = normalizedText(after);
  return protectedFacts(before).every((fact) => normalizedAfter.includes(normalizedText(fact)));
}

function protectedFacts(value: string): string[] {
  const facts = new Set<string>();
  const patterns = [
    /\b\d+(?:\.\d+)?\/5\b/g,
    /\b\d+\s+Google reviews\b/gi,
    /\babout\s+\d+(?:\.\d+)?\s+km away\b/gi,
    /\b[A-Z][A-Za-z0-9'&(). -]{2,80}\s+\(\d+(?:\.\d+)?\/5,\s+\d+\s+Google reviews[^)]*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (match[0].trim()) {
        facts.add(match[0].trim());
      }
    }
  }

  return [...facts];
}

function normalizedText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
