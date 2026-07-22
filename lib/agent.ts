import {
  getListingById,
  getPlacesNearListing,
  getReviewsForListing
} from "@/lib/data";
import { enforceGuardrails, validateProposal } from "@/lib/guardrails";
import { callLlmJson } from "@/lib/llmClient";
import { LISTING_EDITOR_SYSTEM_PROMPT, SUPERVISOR_SYSTEM_PROMPT } from "@/lib/prompts";
import {
  AgentNextActionSchema,
  EditProposalSchema,
  SupervisorOutputSchema,
  type AgentNextAction,
  type EditProposal,
  type SupervisorOutput
} from "@/lib/schemas";
import {
  applySimulatedPageUpdate,
  createAuditLog,
  getSimulatedListingPage
} from "@/lib/simulatedStore";
import type {
  AgentStep,
  AuditLogEntry,
  ExecuteResponse,
  Listing,
  Place,
  Review,
  SimulatedListingPage,
  SimulatedPageUpdate,
  SupervisorDecision
} from "@/lib/types";

type Signal = {
  type: "positive_highlight" | "accuracy_gap" | "insufficient_evidence";
  topic: string;
  evidenceCount: number;
  primaryEvidenceCount: number;
  evidence: string[];
  recommendation: string;
};

type AgentState = {
  prompt: string;
  listingId: string;
  intent: string[];
  selectedActions: string[];
  listing?: Listing;
  page?: SimulatedListingPage;
  claims?: Record<string, unknown>;
  reviews?: Review[];
  relevantReviews?: Review[];
  places?: Place[];
  relevantPlaces?: Place[];
  signals?: Signal[];
  proposal?: EditProposal;
  supervisor?: SupervisorOutput;
  pageUpdate?: SimulatedPageUpdate | null;
  auditLog?: AuditLogEntry | null;
  reviseCount: number;
  requireMoreEvidence: boolean;
  stopReason?: string;
};

const topicKeywords: Record<string, string[]> = {
  location: ["location", "walk", "walking", "metro", "tram", "near", "close", "central"],
  hills: ["hill", "hills", "steep", "walk up", "climb"],
  noise: ["noise", "noisy", "loud", "quiet", "nightlife", "bar", "street"],
  wifi: ["wifi", "wi-fi", "internet", "remote", "work"],
  cleanliness: ["clean", "spotless", "dirty", "dust", "smell"],
  comfort: ["bed", "comfortable", "comfy", "sleep"],
  nearby_highlights: ["restaurant", "park", "museum", "attraction", "cafe", "viewpoint", "nearby", "recommend"]
};

const MAX_ACTIONS = 12;

export async function executeListingAgent(prompt: string): Promise<ExecuteResponse> {
  const steps: AgentStep[] = [];

  try {
    const listingId = extractListingId(prompt);
    if (!listingId) {
      return errorResponse(
        "A valid listing id is required. Select a listing in the UI or include `Selected listing id: <id>` in the prompt.",
        steps
      );
    }

    const state: AgentState = {
      prompt,
      listingId,
      intent: inferIntent(prompt),
      selectedActions: [],
      reviseCount: 0,
      requireMoreEvidence: false
    };

    for (let iteration = 0; iteration < MAX_ACTIONS; iteration += 1) {
      const nextAction = await decideNextAction(state);
      const parsedAction = AgentNextActionSchema.parse(nextAction);

      steps.push(
        step("Autonomous Listing Editor Agent", LISTING_EDITOR_SYSTEM_PROMPT, summarizeState(state), {
          ...parsedAction,
          action_number: iteration + 1,
          llm_mode: process.env.LLM_MODE === "live" ? "live_requested" : "mock"
        })
      );

      state.selectedActions.push(parsedAction.next_action);

      const shouldContinue = await runAction(parsedAction, state, steps);
      if (!shouldContinue || parsedAction.should_stop) {
        break;
      }
    }

    if (!state.listing) {
      return errorResponse(state.stopReason ?? `Listing id ${state.listingId} was not found.`, steps);
    }

    const response = finalResponse(state);

    return {
      status: "ok",
      error: null,
      response,
      steps,
      page_update: state.pageUpdate ?? null,
      audit_log: state.auditLog ?? null
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown execution error",
      response: null,
      steps,
      page_update: null,
      audit_log: null
    };
  }
}

async function decideNextAction(state: AgentState): Promise<AgentNextAction> {
  const mockResponse = chooseNextAction(state);

  const response = await callLlmJson<AgentNextAction>({
    module: "Autonomous Listing Editor Agent",
    messages: [
      { role: "system", content: LISTING_EDITOR_SYSTEM_PROMPT },
      { role: "user", content: summarizeState(state) }
    ],
    mockResponse
  });

  return AgentNextActionSchema.parse(response);
}

function chooseNextAction(state: AgentState): AgentNextAction {
  if (state.stopReason || state.auditLog) {
    return action("stop_without_action", {}, "The runtime already reached a terminal state.", "Stop execution.", true);
  }

  if (!state.listing) {
    return action("get_listing_data", { listing_id: state.listingId }, "The agent needs the selected listing before choosing more tools.", "Listing data is missing.");
  }

  if (!state.claims) {
    return action("extract_claims", { listing_id: state.listingId }, "The agent needs current page claims to compare against observations.", "Current listing claims are missing.");
  }

  if (!state.reviews) {
    return action("search_reviews", { listing_id: state.listingId, topics: state.intent, top_k: 6 }, "Guest reviews are the primary evidence source.", "Review evidence is missing.");
  }

  if (needsGooglePlaces(state) && !state.places) {
    return action("get_google_places", { listing_id: state.listingId, radius_km: 2 }, "Location or nearby-context intent requires environmental context.", "Google Places context is missing.");
  }

  if (!state.signals) {
    return action("detect_guest_signals", { listing_id: state.listingId }, "The agent has observations and must decide whether an editable gap exists.", "Guest signals are missing.");
  }

  if (!state.proposal) {
    return action("draft_listing_edit", { listing_id: state.listingId }, "The agent should draft a narrow proposal or stop when evidence is weak.", "No edit proposal exists.");
  }

  if (!state.supervisor) {
    return action("submit_to_supervisor", { listing_id: state.listingId }, "All page updates require Supervisor / Control Agent review.", "Supervisor decision is missing.");
  }

  if (state.supervisor.decision === "Revise" && state.reviseCount < 1) {
    return action("replan", { required_change: state.supervisor.required_change }, "Supervisor requested a narrower or better evidenced action.", "Replanning after Supervisor revision.");
  }

  if (state.supervisor.decision === "Approve" && !state.auditLog) {
    return action("prepare_edit_proposal", { listing_id: state.listingId, execute: true }, "Supervisor approved the proposal, so the demo page can be updated and audited.", "Approved edit still needs execution.");
  }

  return action("stop_without_action", {}, "No further useful action is available.", "Stop execution.", true);
}

async function runAction(actionRequest: AgentNextAction, state: AgentState, steps: AgentStep[]): Promise<boolean> {
  switch (actionRequest.next_action) {
    case "get_listing_data": {
      const listing = await getListingById(state.listingId);
      if (!listing) {
        state.stopReason = `Listing id ${state.listingId} was not found. No fallback listing was used.`;
        steps.push(step("Listing Tools", "Retrieve the selected listing only.", JSON.stringify(actionRequest.tool_input), {
          found: false,
          listing_id: state.listingId,
          safety_note: "The agent stopped instead of editing the wrong listing."
        }));
        return false;
      }

      state.listing = listing;
      state.page = getSimulatedListingPage(listing);
      steps.push(step("Listing Tools", "Retrieve the selected listing and simulated page state.", JSON.stringify(actionRequest.tool_input), {
        found: true,
        listing_id: listing.id,
        listing_name: listing.name,
        current_page_description_excerpt: excerpt(state.page.currentDescription)
      }));
      return true;
    }

    case "extract_claims": {
      if (!state.listing || !state.page) {
        throw new Error("Cannot extract claims before listing data is loaded.");
      }

      state.claims = extractClaims(state.listing, state.page.currentDescription);
      steps.push(step("Listing Tools", "Extract editable claims from the current simulated listing page.", JSON.stringify(actionRequest.tool_input), {
        listing_id: state.listing.id,
        current_claims: state.claims
      }));
      return true;
    }

    case "search_reviews": {
      if (!state.listing) {
        throw new Error("Cannot search reviews before listing data is loaded.");
      }

      const reviews = await getReviewsForListing(state.listing.id);
      const relevantReviews = searchRelevantReviews(reviews, state.intent, state.requireMoreEvidence ? 12 : 6);
      state.reviews = reviews;
      state.relevantReviews = relevantReviews;
      steps.push(step("Review RAG", "Retrieve Airbnb guest reviews for the selected listing.", JSON.stringify(actionRequest.tool_input), {
        listing_id: state.listing.id,
        total_reviews_available: reviews.length,
        retrieved_reviews: relevantReviews.map((review) => ({
          review_id: review.id,
          listing_id: review.listingId,
          date: review.date,
          excerpt: excerpt(review.comments)
        })),
        retrieval_note: "Airbnb reviews are the primary evidence source and are filtered by listing_id."
      }));
      return true;
    }

    case "get_google_places": {
      if (!state.listing) {
        throw new Error("Cannot retrieve places before listing data is loaded.");
      }

      const places = await getPlacesNearListing(state.listing, 40);
      const relevantPlaces = filterRelevantPlaces(places, state.intent);
      state.places = places;
      state.relevantPlaces = relevantPlaces;
      steps.push(step("Google Places Context", "Retrieve nearby Google Places context when relevant.", JSON.stringify(actionRequest.tool_input), {
        listing_id: state.listing.id,
        nearby_places: relevantPlaces.map((place) => ({
          name: place.placeName,
          category: place.category,
          rating: place.rating,
          distance_km: Number(place.distanceKm?.toFixed(2))
        })),
        context_rule: "Google Places can support environmental context but cannot alone prove guest experience."
      }));
      return true;
    }

    case "detect_guest_signals": {
      if (!state.listing || !state.relevantReviews) {
        throw new Error("Cannot detect guest signals before listing reviews are retrieved.");
      }

      state.signals = detectSignals(
        state.listing,
        state.page?.currentDescription ?? state.listing.description,
        state.relevantReviews,
        state.relevantPlaces ?? [],
        state.intent
      );
      steps.push(step("Review RAG", "Detect guest signals and evidence strength.", JSON.stringify(actionRequest.tool_input), {
        signals: state.signals,
        validation: validateEvidence(state)
      }));
      return true;
    }

    case "draft_listing_edit": {
      if (!state.listing || !state.signals) {
        throw new Error("Cannot draft an edit before signals are detected.");
      }

      const proposal = EditProposalSchema.parse(draftEdit(state.listing, state.signals));
      state.proposal = proposal;
      steps.push(step("Edit & Decision Tools", "Draft a narrow page edit, ask for more evidence, or stop.", JSON.stringify(actionRequest.tool_input), {
        proposed_action: proposal,
        evidence_validation: validateEvidence(state)
      }));
      return true;
    }

    case "submit_to_supervisor": {
      if (!state.proposal || !state.signals) {
        throw new Error("Cannot submit to Supervisor before an edit proposal exists.");
      }

      const guardrails = validateProposal(state.proposal, state);
      const supervisorDraft = await callLlmJson<SupervisorOutput>({
        module: "Supervisor / Control Agent",
        messages: [
          { role: "system", content: SUPERVISOR_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ proposal: state.proposal, signals: state.signals, guardrails }) }
        ],
        mockResponse: supervise(state.proposal, state.signals, guardrails.passed)
      });
      state.supervisor = SupervisorOutputSchema.parse(enforceGuardrails(state.proposal, supervisorDraft, state));

      steps.push(step("Supervisor / Control Agent", SUPERVISOR_SYSTEM_PROMPT, JSON.stringify({ proposal: state.proposal, signals: state.signals, guardrails }), {
        ...state.supervisor,
        guardrails
      }));
      return true;
    }

    case "replan": {
      state.reviseCount += 1;
      state.requireMoreEvidence = true;
      state.supervisor = undefined;
      state.proposal = undefined;
      state.signals = undefined;
      state.reviews = undefined;
      state.relevantReviews = undefined;
      steps.push(step("Edit & Decision Tools", "Replan after Supervisor requested revision.", JSON.stringify(actionRequest.tool_input), {
        replan_count: state.reviseCount,
        next_observation_needed: "Retrieve more focused Airbnb review evidence before drafting again."
      }));
      return true;
    }

    case "prepare_edit_proposal": {
      if (!state.listing || !state.proposal || !state.supervisor) {
        throw new Error("Cannot execute approved proposal before listing, proposal, and Supervisor decision exist.");
      }

      state.pageUpdate = applySimulatedPageUpdate(state.listing, state.proposal, state.supervisor.decision);
      state.auditLog = createAuditLog({
        listing: state.listing,
        managerPrompt: state.prompt,
        decision: state.supervisor.decision,
        selectedActions: state.selectedActions,
        evidenceSummary: state.signals ?? [],
        proposal: state.proposal,
        supervisorRationale: state.supervisor.rationale,
        executedInDemoEnvironment: state.pageUpdate.status === "executed"
      });

      steps.push(step("Edit & Decision Tools", "Execute approved simulated page update and write audit log.", JSON.stringify(actionRequest.tool_input), {
        page_update: state.pageUpdate,
        audit_log: state.auditLog
      }));
      return false;
    }

    case "stop_without_action": {
      if (state.listing && !state.auditLog) {
        const decision = state.supervisor?.decision ?? "Block";
        state.pageUpdate = applySimulatedPageUpdate(state.listing, state.proposal ?? stopProposal(state.listing.id), decision);
        state.auditLog = createAuditLog({
          listing: state.listing,
          managerPrompt: state.prompt,
          decision,
          selectedActions: state.selectedActions,
          evidenceSummary: state.signals ?? [],
          proposal: state.proposal ?? stopProposal(state.listing.id),
          supervisorRationale: state.supervisor?.rationale ?? state.stopReason ?? "The agent stopped without an evidence-backed edit.",
          executedInDemoEnvironment: false
        });
      }

      steps.push(step("Edit & Decision Tools", "Stop without editing the simulated listing page.", JSON.stringify(actionRequest.tool_input), {
        reason: state.stopReason ?? "No further action justified.",
        audit_log: state.auditLog
      }));
      return false;
    }

    default:
      state.stopReason = `Unsupported action requested: ${actionRequest.next_action}`;
      return false;
  }
}

function extractListingId(prompt: string): string | null {
  const explicit = prompt.match(/selected listing id:\s*(\d{8,})/i);
  if (explicit?.[1]) {
    return explicit[1];
  }

  const fallback = prompt.match(/\b\d{8,}\b/);
  return fallback?.[0] ?? null;
}

function inferIntent(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const topics = Object.entries(topicKeywords)
    .filter(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)))
    .map(([topic]) => topic);

  if (topics.length > 0) {
    return topics;
  }

  return ["location"];
}

function needsGooglePlaces(state: AgentState): boolean {
  return (
    state.intent.includes("location") ||
    state.intent.includes("noise") ||
    state.intent.includes("nearby_highlights") ||
    state.intent.includes("hills")
  );
}

function extractClaims(listing: Listing, currentDescription: string): Record<string, unknown> {
  const description = currentDescription.toLowerCase();
  return {
    mentions_quiet: description.includes("quiet"),
    mentions_nightlife: description.includes("nightlife") || description.includes("entertainment"),
    mentions_hills: description.includes("hill") || description.includes("steep"),
    mentions_wifi: description.includes("wifi") || listing.amenities.some((amenity) => amenity.toLowerCase().includes("wifi")),
    mentions_nearby_attractions:
      description.includes("restaurant") ||
      description.includes("park") ||
      description.includes("museum") ||
      description.includes("attraction") ||
      description.includes("nearby highlights"),
    amenities: listing.amenities.slice(0, 8)
  };
}

function searchRelevantReviews(reviews: Review[], intent: string[], topK: number): Review[] {
  const keywords = intent.flatMap((topic) => topicKeywords[topic] ?? []);
  const scored = reviews.map((review) => {
    const normalized = review.comments.toLowerCase();
    const score = keywords.reduce((total, keyword) => total + (normalized.includes(keyword) ? 1 : 0), 0);
    return { review, score };
  });

  const matches = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.review);

  return (matches.length > 0 ? matches : reviews).slice(0, topK);
}

function filterRelevantPlaces(places: Place[], intent: string[]): Place[] {
  if (intent.includes("nearby_highlights")) {
    return places
      .filter((place) => /Culture|Parks_Recreation|Dining/i.test(place.category))
      .filter((place) => (place.rating ?? 0) >= 4.3 && place.numberOfReviews >= 15)
      .slice(0, 5);
  }

  if (intent.includes("noise")) {
    return places.filter((place) => /bar|restaurant|night|cafe/i.test(`${place.category} ${place.placeName}`)).slice(0, 5);
  }

  return places.slice(0, 5);
}

function detectSignals(
  listing: Listing,
  currentDescription: string,
  reviews: Review[],
  places: Place[],
  intent: string[]
): Signal[] {
  const signals: Signal[] = [];
  const reviewText = reviews.map((review) => review.comments.toLowerCase()).join(" ");
  const description = currentDescription.toLowerCase();

  if (intent.includes("hills") || reviewText.includes("hill") || reviewText.includes("steep")) {
    const evidence = reviews
      .filter((review) => /hill|steep|walk up|climb/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 2 && !description.includes("hill") && !description.includes("steep")) {
      signals.push({
        type: "accuracy_gap",
        topic: "Historic Lisbon hills",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add a gentle expectation-setting note about steep nearby walks."
      });
    }
  }

  if (intent.includes("noise") || reviewText.includes("noisy") || reviewText.includes("quiet")) {
    const evidence = reviews
      .filter((review) => /noise|noisy|loud|quiet|street|night/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 2 && description.includes("quiet")) {
      signals.push({
        type: "accuracy_gap",
        topic: "Noise expectations",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Soften quiet claims and set accurate expectations about the street environment."
      });
    }
  }

  if (intent.includes("wifi") || reviewText.includes("wifi") || reviewText.includes("internet")) {
    const evidence = reviews
      .filter((review) => /wifi|wi-fi|internet|remote|work/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    const hasWifiAmenity = listing.amenities.some((amenity) => amenity.toLowerCase().includes("wifi"));
    if (evidence.length >= 2 && hasWifiAmenity) {
      signals.push({
        type: "positive_highlight",
        topic: "Remote-work readiness",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Mention verified Wi-Fi/work setup only if the listing amenities already support it."
      });
    }
  }

  if (intent.includes("nearby_highlights") && places.length >= 3 && !description.includes("nearby highlights")) {
    const topPlaces = places.slice(0, 3).map((place) => place.placeName);
    const reviewSupport = reviews.filter((review) => /nearby|restaurant|park|cafe|attraction|location/i.test(review.comments));
    signals.push({
      type: "positive_highlight",
      topic: "Nearby guest highlights",
      evidenceCount: places.length + reviewSupport.length,
      primaryEvidenceCount: reviewSupport.length,
      evidence: [...reviewSupport.slice(0, 2).map((review) => excerpt(review.comments)), ...topPlaces],
      recommendation: "Add a concise nearby highlights note based on guest location comments plus Google Places context."
    });
  }

  if (signals.length === 0) {
    signals.push({
      type: "insufficient_evidence",
      topic: "No strong editable gap",
      evidenceCount: reviews.length,
      primaryEvidenceCount: reviews.length,
      evidence: reviews.slice(0, 2).map((review) => excerpt(review.comments)),
      recommendation: "Stop without editing because the agent cannot justify a page update."
    });
  }

  return signals;
}

function draftEdit(listing: Listing, signals: Signal[]): EditProposal {
  const editableSignals = signals.filter((signal) => signal.type !== "insufficient_evidence" && signal.primaryEvidenceCount >= 2);

  if (editableSignals.length === 0) {
    const weakEditableSignals = signals.filter((signal) => signal.type !== "insufficient_evidence" && signal.primaryEvidenceCount > 0);
    if (weakEditableSignals.length > 0) {
      return {
        action: "request_more_evidence",
        reason: "Potential editable signal found, but primary Airbnb review evidence is still too weak.",
        listing_id: listing.id,
        proposed_description_addition: null,
        target_fields: [],
        evidence_topics: weakEditableSignals.map((signal) => signal.topic)
      };
    }

    return stopProposal(listing.id, "No strong, editable gap was found.");
  }

  const additions = editableSignals.map((signal) => {
    if (signal.topic === "Historic Lisbon hills") {
      return "Guest note: this historic Lisbon area is rewarding to explore on foot, and some nearby streets include steep walks.";
    }
    if (signal.topic === "Noise expectations") {
      return "Guest note: the apartment is in an active Lisbon neighborhood, so occasional street activity may be heard.";
    }
    if (signal.topic === "Remote-work readiness") {
      return "Work-friendly note: guests mention the setup works well for short remote-work stays.";
    }
    if (signal.topic === "Nearby guest highlights") {
      const placeNames = signal.evidence.filter((item) => !item.includes("...")).slice(-3);
      return `Nearby highlights: ${placeNames.join(", ")} are located within the surrounding Lisbon area.`;
    }
    return signal.recommendation;
  });

  return {
    action: "prepare_edit_proposal",
    target_fields: ["description"],
    listing_id: listing.id,
    proposed_description_addition: additions.join(" "),
    evidence_topics: editableSignals.map((signal) => signal.topic)
  };
}

function supervise(proposal: EditProposal, signals: Signal[], guardrailsPassed: boolean): SupervisorOutput {
  if (!guardrailsPassed) {
    return {
      decision: "Block",
      rationale: "The proposal failed runtime guardrails."
    };
  }

  if (proposal.action === "stop_without_action") {
    return {
      decision: "Block",
      rationale: "The agent did not find enough evidence for an autonomous page edit."
    };
  }

  if (proposal.action === "request_more_evidence") {
    return {
      decision: "Revise",
      rationale: "The agent found a possible gap, but the evidence is not strong enough for approval.",
      required_change: "Retrieve more focused Airbnb review evidence before drafting a page edit."
    };
  }

  const hasStrongSignal = signals.some((signal) => signal.type !== "insufficient_evidence" && signal.primaryEvidenceCount >= 2);

  if (hasStrongSignal) {
    return {
      decision: "Approve",
      rationale: "The proposal is narrow, evidence-backed, and updates only the simulated listing page."
    };
  }

  return {
    decision: "Revise",
    rationale: "The proposal may be useful, but the evidence is not strong enough yet.",
    required_change: "Retrieve more Airbnb review evidence or narrow the edit."
  };
}

function validateEvidence(state: AgentState) {
  const reviewsBelongToListing =
    !state.relevantReviews || state.relevantReviews.every((review) => review.listingId === state.listingId);
  const strongestPrimaryEvidence = Math.max(...(state.signals ?? []).map((signal) => signal.primaryEvidenceCount), 0);
  const googlePlacesOnly =
    Boolean(state.signals?.some((signal) => signal.type !== "insufficient_evidence")) && strongestPrimaryEvidence === 0;

  return {
    reviews_belong_to_listing: reviewsBelongToListing,
    strongest_primary_evidence_count: strongestPrimaryEvidence,
    google_places_only: googlePlacesOnly,
    passed: reviewsBelongToListing && !googlePlacesOnly
  };
}

function finalResponse(state: AgentState): string {
  if (!state.listing) {
    return state.stopReason ?? "No listing was selected.";
  }

  if (state.supervisor?.decision === "Approve" && state.pageUpdate?.status === "executed") {
    return [
      `Approved and executed in the demo environment for listing ${state.listing.id}: ${state.listing.name}.`,
      "",
      `Updated field: ${state.pageUpdate.field}.`,
      `Added text: ${state.pageUpdate.addedText}`,
      "",
      "No live Airbnb account was accessed. The update was applied only to the simulated listing page and recorded in the audit log."
    ].join("\n");
  }

  if (state.supervisor?.decision === "Revise") {
    return `The Supervisor requested revision for listing ${state.listing.id}. The agent replanned once and stopped because a safe approved edit was not available. No live Airbnb account was accessed.`;
  }

  return `No action was taken for listing ${state.listing.id}. The agent did not find enough validated evidence for a safe page update. No live Airbnb account was accessed.`;
}

function stopProposal(listingId: string, reason = "No strong, editable gap was found."): EditProposal {
  return {
    action: "stop_without_action",
    reason,
    listing_id: listingId,
    proposed_description_addition: null,
    target_fields: []
  };
}

function action(
  nextAction: AgentNextAction["next_action"],
  toolInput: Record<string, unknown>,
  rationale: string,
  stateUpdate: string,
  shouldStop = false
): AgentNextAction {
  return {
    next_action: nextAction,
    tool_input: toolInput,
    short_rationale: rationale,
    state_update: stateUpdate,
    should_stop: shouldStop
  };
}

function summarizeState(state: AgentState): string {
  return JSON.stringify({
    listing_id: state.listingId,
    intent: state.intent,
    selected_actions_so_far: state.selectedActions,
    has_listing: Boolean(state.listing),
    has_claims: Boolean(state.claims),
    has_review_observations: Boolean(state.relevantReviews),
    has_google_places_context: Boolean(state.relevantPlaces),
    has_signals: Boolean(state.signals),
    has_proposal: Boolean(state.proposal),
    supervisor_decision: state.supervisor?.decision,
    revise_count: state.reviseCount,
    terminal_reason: state.stopReason
  });
}

function step(module: string, systemPrompt: string, userPrompt: string, response: unknown): AgentStep {
  return {
    module,
    prompt: {
      system_prompt: systemPrompt,
      user_prompt: userPrompt
    },
    response
  };
}

function errorResponse(error: string, steps: AgentStep[]): ExecuteResponse {
  return {
    status: "error",
    error,
    response: null,
    steps,
    page_update: null,
    audit_log: null
  };
}

function excerpt(value: string, length = 220): string {
  return value.length > length ? `${value.slice(0, length).trim()}...` : value;
}
