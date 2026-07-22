export type AgentIntentPlan = {
  selected_listing_id: string;
  inferred_intent: string[];
  selected_tools: string[];
  rationale: string;
};

export type EditProposal = {
  action: "prepare_edit_proposal" | "request_more_evidence" | "stop_without_action";
  target_fields: string[];
  listing_id?: string;
  proposed_description_addition: string | null;
  evidence_topics?: string[];
  reason?: string;
};

export type SupervisorOutput = {
  decision: "Approve" | "Revise" | "Block";
  rationale: string;
  required_change?: string;
};

export const ALLOWED_TOOL_NAMES = [
  "get_listing_data",
  "extract_claims",
  "search_reviews",
  "detect_guest_signals",
  "get_google_places",
  "compare_location_context",
  "draft_listing_edit",
  "prepare_edit_proposal",
  "request_more_evidence",
  "stop_without_action",
  "replan",
  "submit_to_supervisor"
] as const;

export const EDITABLE_FIELDS = ["description", "house_rules", "amenities_note"] as const;

export const FORBIDDEN_ACTION_TOPICS = [
  "live_airbnb_access",
  "scraping",
  "pricing",
  "availability",
  "private_messages",
  "review_replies",
  "unsupported_amenities"
] as const;
