import type { EditProposal, SupervisorOutput } from "@/lib/schemas";

export type GuardrailResult = {
  passed: boolean;
  violations: string[];
};

const forbiddenPatterns = [
  { name: "pricing", pattern: /\b(price|pricing|discount|rate|nightly|fee)\b/i },
  { name: "live_airbnb_access", pattern: /\b(live airbnb|airbnb account|real account|scrape|scraping)\b/i },
  { name: "private_messages", pattern: /\b(private message|inbox|guest message|dm)\b/i },
  { name: "review_replies", pattern: /\b(reply to review|respond to review|answer reviews)\b/i },
  { name: "unsupported_amenities", pattern: /\b(add pool|add gym|add parking|add air conditioning|add washer)\b/i }
];

export function validateProposal(proposal: EditProposal): GuardrailResult {
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

  return {
    passed: violations.length === 0,
    violations
  };
}

export function enforceGuardrails(
  proposal: EditProposal,
  supervisor: SupervisorOutput
): SupervisorOutput {
  const validation = validateProposal(proposal);

  if (validation.passed) {
    return supervisor;
  }

  return {
    decision: "Block",
    rationale: `Blocked by guardrails: ${validation.violations.join(", ")}.`
  };
}
