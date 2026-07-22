import {
  getListingById,
  getManagedDemoListings,
  getPlacesNearListing,
  getReviewSearchResult,
  getReviewTextCountForListing
} from "@/lib/data";
import { enforceGuardrails, validateProposal } from "@/lib/guardrails";
import { callLlmJson } from "@/lib/llmClient";
import { LISTING_EDITOR_SYSTEM_PROMPT, SUPERVISOR_SYSTEM_PROMPT } from "@/lib/prompts";
import { classifyPromptScope } from "@/lib/requestScope";
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
  EvidenceReport,
  Listing,
  ManagerRecommendation,
  Place,
  PortfolioListingResult,
  Review,
  SimulatedListingPage,
  SimulatedPageUpdate,
  SupervisorDecision
} from "@/lib/types";

type Signal = {
  type: "positive_highlight" | "accuracy_gap" | "guest_experience_detail" | "insufficient_evidence";
  topic: string;
  evidenceCount: number;
  primaryEvidenceCount: number;
  evidence: string[];
  recommendation: string;
};

type AgentState = {
  prompt: string;
  listingId: string;
  currentDescriptionOverride?: string;
  intent: string[];
  selectedActions: string[];
  observations: string[];
  deterministicPlanner?: boolean;
  listing?: Listing;
  page?: SimulatedListingPage;
  claims?: Record<string, unknown>;
  reviews?: Review[];
  reviewSource?: "pinecone" | "csv_fallback";
  indexedReviewTextCount?: number;
  relevantReviews?: Review[];
  places?: Place[];
  relevantPlaces?: Place[];
  signals?: Signal[];
  proposal?: EditProposal;
  managerRecommendations?: ManagerRecommendation[];
  evidenceReport?: EvidenceReport;
  supervisor?: SupervisorOutput;
  pageUpdate?: SimulatedPageUpdate | null;
  auditLog?: AuditLogEntry | null;
  reviseCount: number;
  requireMoreEvidence: boolean;
  stopReason?: string;
};

const topicKeywords: Record<string, string[]> = {
  review_alignment: ["improve", "gap", "gaps", "align", "experience", "guest", "review", "reviews", "end to end"],
  location: ["location", "walk", "walking", "metro", "tram", "near", "close", "central"],
  hills: ["hill", "hills", "steep", "walk up", "climb"],
  stairs: ["stairs", "steps", "elevator", "lift"],
  noise: ["noise", "noisy", "loud", "quiet", "nightlife", "bar", "street"],
  wifi: ["wifi", "wi-fi", "internet", "remote", "work"],
  cleanliness: ["clean", "spotless", "dirty", "dust", "smell"],
  comfort: ["bed", "comfortable", "comfy", "sleep"],
  temperature: ["hot", "warm", "cold", "air conditioning", "a/c", "ac", "heating"],
  view: ["view", "views", "river", "terrace", "balcony"],
  space: ["small", "tiny", "compact", "cramped"],
  property_fixes: ["fix", "repair", "maintenance", "issue", "issues", "problem", "complaint", "bothering", "improve the property", "quality", "income", "revenue"],
  evidence_search: ["evidence", "evidance", "avidance", "proof", "examples", "more signals", "more reviews", "find more", "show me"],
  nearby_highlights: ["restaurant", "park", "museum", "attraction", "cafe", "viewpoint", "nearby", "recommend"],
  restore_original: ["restore", "revert", "undo", "reset", "back to original", "previous version", "לא אהבתי", "חזור", "תחזיר", "בטל"]
};

const MAX_ACTIONS = 16;
const MAX_PORTFOLIO_LISTINGS = 8;

export async function executeListingAgent(prompt: string): Promise<ExecuteResponse> {
  return executeListingAgentWithOptions(prompt, {});
}

type ExecuteOptions = {
  currentPageDescription?: string;
  portfolioPageDescriptions?: Record<string, string>;
};

export async function executeListingAgentWithOptions(prompt: string, options: ExecuteOptions = {}): Promise<ExecuteResponse> {
  const steps: AgentStep[] = [];

  try {
    const scopeDecision = classifyPromptScope(prompt);
    steps.push(step("Input Scope Guard", "Check whether the request belongs to the agent's allowed domain before using retrieval or LLM.", prompt, {
      category: scopeDecision.category,
      in_scope: scopeDecision.inScope,
      reason: scopeDecision.reason,
      token_safety: "No LLM, Review RAG, or Google Places calls happen before this guard passes."
    }));

    if (!scopeDecision.inScope) {
      return {
        status: "ok",
        error: null,
        response: scopeDecision.safeResponse,
        steps,
        page_update: null,
        portfolio_update: null,
        audit_log: null
      };
    }

    if (scopeDecision.category === "capability_question") {
      return {
        status: "ok",
        error: null,
        response: scopeDecision.safeResponse,
        steps,
        page_update: null,
        portfolio_update: null,
        audit_log: null
      };
    }

    if (isPortfolioRequest(prompt)) {
      return executePortfolioAgent(prompt, steps, options.portfolioPageDescriptions ?? {});
    }

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
      currentDescriptionOverride: options.currentPageDescription,
      intent: inferIntent(prompt),
      selectedActions: [],
      observations: [],
      reviseCount: 0,
      requireMoreEvidence: false
    };

    return runSingleListingAgent(state, steps);
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown execution error",
      response: null,
      steps,
      page_update: null,
      portfolio_update: null,
      audit_log: null
    };
  }
}

async function runSingleListingAgent(state: AgentState, steps: AgentStep[]): Promise<ExecuteResponse> {
  for (let iteration = 0; iteration < MAX_ACTIONS; iteration += 1) {
    const nextAction = await decideNextAction(state);
    const parsedAction = AgentNextActionSchema.parse(nextAction);

    steps.push(
      step("Autonomous Listing Editor Agent", LISTING_EDITOR_SYSTEM_PROMPT, summarizeState(state), {
        ...parsedAction,
        action_number: iteration + 1,
        llm_mode: state.deterministicPlanner
          ? "deterministic_policy"
          : process.env.LLM_MODE === "live"
            ? "live_requested"
            : "mock"
      })
    );

    state.selectedActions.push(parsedAction.next_action);

    const shouldContinue = await runAction(parsedAction, state, steps);
    if (!shouldContinue || (parsedAction.should_stop && parsedAction.next_action === "stop_without_action")) {
      break;
    }
  }

  if (!state.listing) {
    return errorResponse(state.stopReason ?? `Listing id ${state.listingId} was not found.`, steps);
  }

  return {
    status: "ok",
    error: null,
    response: finalResponse(state),
    steps,
    page_update: state.pageUpdate ?? null,
    portfolio_update: null,
    evidence_report: state.evidenceReport ?? null,
    manager_recommendations: state.managerRecommendations ?? null,
    audit_log: state.auditLog ?? null
  };
}

async function executePortfolioAgent(
  prompt: string,
  steps: AgentStep[],
  portfolioPageDescriptions: Record<string, string>
): Promise<ExecuteResponse> {
  const managedListings = await getManagedDemoListings(MAX_PORTFOLIO_LISTINGS);
  steps.push(step("Portfolio Manager", "Select the manager-owned demo listings with the richest evidence.", prompt, {
    requested_listings: managedListings.length,
    selection_rule: "Highest Airbnb review count plus nearby Google Places coverage.",
    listings: managedListings.map((listing) => ({
      listing_id: listing.id,
      listing_name: listing.name,
      reviews: listing.numberOfReviews,
      nearby_places: listing.nearbyPlacesCount
    })),
    token_safety: "The portfolio request reuses the same deterministic scope guard and stops per listing when evidence is insufficient."
  }));

  const results: PortfolioListingResult[] = [];

  for (const listing of managedListings) {
    const listingSteps: AgentStep[] = [];
    const listingPrompt = `Selected listing id: ${listing.id}\n${portfolioPromptForListing(prompt, listing.name)}`;
    const state: AgentState = {
      prompt: listingPrompt,
      listingId: listing.id,
      currentDescriptionOverride: portfolioPageDescriptions[listing.id],
      intent: inferIntent(listingPrompt),
      selectedActions: [],
      observations: [],
      deterministicPlanner: true,
      reviseCount: 0,
      requireMoreEvidence: false
    };
    const result = await runSingleListingAgent(state, listingSteps);
    const decision = result.audit_log?.decision ?? null;
    const portfolioResult: PortfolioListingResult = {
      listingId: listing.id,
      listingName: listing.name,
      status: result.status === "error" ? "error" : result.page_update?.status ?? "not_executed",
      decision,
      response: result.response ?? result.error,
      updatedField: result.page_update?.field ?? null,
      addedText: result.page_update?.addedText ?? null,
      before: result.page_update?.before ?? null,
      after: result.page_update?.after ?? null,
      selectedActions: result.audit_log?.selectedActions ?? selectedActionsFromSteps(listingSteps)
    };
    results.push(portfolioResult);

    steps.push(step("Portfolio Listing Run", "Run the autonomous listing editor on one managed listing.", listingPrompt, {
      listing_id: listing.id,
      listing_name: listing.name,
      status: portfolioResult.status,
      decision,
      selected_actions: portfolioResult.selectedActions,
      response: portfolioResult.response,
      page_update: result.page_update
        ? {
            status: result.page_update.status,
            field: result.page_update.field,
            addedText: result.page_update.addedText
          }
        : null
    }));
  }

  const executed = results.filter((result) => result.status === "executed").length;
  const skipped = results.length - executed;
  const portfolioUpdate = {
    requestedListings: results.length,
    executed,
    skipped,
    results
  };

  return {
    status: "ok",
    error: null,
    response: [
      `Portfolio request completed for ${results.length} managed Lisbon listings.`,
      `${executed} in-session simulated listing pages were updated; ${skipped} were left unchanged because the agent did not have a safe approved edit.`,
      "Each listing used its own evidence check, Supervisor decision, and read-only data boundaries. No live Airbnb account was accessed."
    ].join("\n"),
    steps,
    page_update: null,
    portfolio_update: portfolioUpdate,
    audit_log: null
  };
}

async function decideNextAction(state: AgentState): Promise<AgentNextAction> {
  const mockResponse = chooseNextAction(state);

  if (state.deterministicPlanner) {
    return enforceActionPreconditions(state, mockResponse);
  }

  const response = await callLlmJson<AgentNextAction>({
    module: "Autonomous Listing Editor Agent",
    messages: [
      { role: "system", content: LISTING_EDITOR_SYSTEM_PROMPT },
      { role: "user", content: summarizeState(state) }
    ],
    mockResponse
  });

  const parsed = AgentNextActionSchema.safeParse(response);
  if (!parsed.success) {
    state.observations.push("LLM action output failed runtime validation; deterministic policy selected the next action.");
    return enforceActionPreconditions(state, mockResponse);
  }

  return enforceActionPreconditions(state, parsed.data);
}

function enforceActionPreconditions(state: AgentState, proposed: AgentNextAction): AgentNextAction {
  if (!state.listing && proposed.next_action !== "get_listing_data") {
    return action(
      "get_listing_data",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "Runtime preconditions require loading the selected listing before any page, review, Places, restore, or Supervisor action.",
      "Listing data is missing."
    );
  }

  if (state.listing && !state.claims && !isRestoreRequest(state) && !needsEvidenceReport(state) && proposed.next_action !== "extract_claims") {
    return action(
      "extract_claims",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "Runtime preconditions require extracting current page claims before searching for editable gaps.",
      "Current listing claims are missing."
    );
  }

  if (state.listing && needsEvidenceReport(state) && !state.reviews && proposed.next_action !== "search_reviews") {
    return action(
      "search_reviews",
      { listing_id: state.listingId, topics: state.intent, top_k: reviewRetrievalLimit(state), runtime_override_from: proposed.next_action },
      "The manager asked for more review evidence only, so the agent should retrieve focused guest reviews before producing a report.",
      "Evidence-only request needs review retrieval."
    );
  }

  if (state.claims && !state.reviews && proposed.next_action !== "search_reviews") {
    return action(
      "search_reviews",
      { listing_id: state.listingId, topics: state.intent, top_k: reviewRetrievalLimit(state), runtime_override_from: proposed.next_action },
      "Airbnb guest reviews are the primary evidence source before drafting any page edit.",
      "Review evidence is missing."
    );
  }

  if (
    state.reviews &&
    !needsEvidenceReport(state) &&
    needsGooglePlaces(state) &&
    !state.places &&
    proposed.next_action !== "get_google_places"
  ) {
    return action(
      "get_google_places",
      { listing_id: state.listingId, radius_km: 2, runtime_override_from: proposed.next_action },
      "This request needs nearby Lisbon context, so Google Places context must be observed before detecting final signals.",
      "Google Places context is missing."
    );
  }

  if (
    state.reviews &&
    !needsEvidenceReport(state) &&
    (!needsGooglePlaces(state) || state.places) &&
    !state.signals &&
    proposed.next_action !== "detect_guest_signals"
  ) {
    return action(
      "detect_guest_signals",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "The agent has enough observations to detect guest signals and decide whether an editable gap exists.",
      "Guest signals are missing."
    );
  }

  if (
    state.signals &&
    !needsEvidenceReport(state) &&
    needsManagerRecommendations(state) &&
    !state.managerRecommendations &&
    proposed.next_action !== "draft_manager_recommendations"
  ) {
    return action(
      "draft_manager_recommendations",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "The manager asked for property improvement recommendations, not a page edit.",
      "Manager recommendations are missing."
    );
  }

  if (state.reviews && needsEvidenceReport(state) && !state.evidenceReport && proposed.next_action !== "draft_evidence_report") {
    return action(
      "draft_evidence_report",
      { listing_id: state.listingId, topics: state.intent, runtime_override_from: proposed.next_action },
      "The manager asked for supporting evidence, not a page edit.",
      "Evidence report is missing."
    );
  }

  if (state.signals && !needsManagerRecommendations(state) && !needsEvidenceReport(state) && !state.proposal && proposed.next_action !== "draft_listing_edit") {
    return action(
      "draft_listing_edit",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "Detected signals must be turned into a narrow proposal, a request for more evidence, or a stop decision.",
      "No edit proposal exists."
    );
  }

  if (state.listing && isRestoreRequest(state) && !state.proposal && proposed.next_action !== "restore_original_page") {
    return action(
      "restore_original_page",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "The manager asked to undo the simulated edit, so the legal next action is restoring from the original dataset text.",
      "A restore proposal is needed."
    );
  }

  if (state.proposal && !state.supervisor && proposed.next_action !== "submit_to_supervisor") {
    return action(
      "submit_to_supervisor",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "A proposed page action must be reviewed by the Supervisor / Control Agent before execution.",
      "Supervisor decision is missing."
    );
  }

  if (state.supervisor?.decision === "Approve" && !state.auditLog && proposed.next_action !== "prepare_edit_proposal") {
    return action(
      "prepare_edit_proposal",
      { listing_id: state.listingId, execute: true, runtime_override_from: proposed.next_action },
      "Supervisor approved the proposal, so the only legal next action is execution in the simulated page plus audit logging.",
      "Approved action still needs execution."
    );
  }

  return proposed;
}

function chooseNextAction(state: AgentState): AgentNextAction {
  if (state.stopReason || state.auditLog || state.managerRecommendations || state.evidenceReport) {
    return action("stop_without_action", {}, "The runtime already reached a terminal state.", "Stop execution.", true);
  }

  if (!state.listing) {
    return action("get_listing_data", { listing_id: state.listingId }, "The agent needs the selected listing before choosing more tools.", "Listing data is missing.");
  }

  if (isRestoreRequest(state)) {
    if (!state.proposal) {
      return action("restore_original_page", { listing_id: state.listingId }, "The manager asked to undo the simulated edit, so the agent can restore the page from the read-only dataset source.", "A restore proposal is needed.");
    }

    if (!state.supervisor) {
      return action("submit_to_supervisor", { listing_id: state.listingId }, "Even a restore action goes through Supervisor / Control Agent approval.", "Supervisor decision is missing.");
    }

    if (state.supervisor.decision === "Approve" && !state.auditLog) {
      return action("prepare_edit_proposal", { listing_id: state.listingId, execute: true }, "Supervisor approved restoring the simulated page to the original dataset text.", "Approved restore still needs execution.");
    }

    return action("stop_without_action", {}, "The restore request reached a terminal state.", "Stop execution.", true);
  }

  if (needsEvidenceReport(state)) {
    if (!state.reviews) {
      return action(
        "search_reviews",
        { listing_id: state.listingId, topics: state.intent, top_k: reviewRetrievalLimit(state) },
        "The manager asked for more evidence, so the agent should retrieve focused Airbnb review examples rather than edit the page.",
        "Review evidence is missing."
      );
    }

    if (!state.evidenceReport) {
      return action(
        "draft_evidence_report",
        { listing_id: state.listingId, topics: state.intent },
        "The request is evidence-only; produce a manager-facing report and stop without Supervisor or page update.",
        "Evidence report is missing."
      );
    }

    return action("stop_without_action", {}, "The evidence-only request reached a terminal state.", "Stop execution.", true);
  }

  if (!state.claims) {
    return action("extract_claims", { listing_id: state.listingId }, "The agent needs current page claims to compare against observations.", "Current listing claims are missing.");
  }

  if (!state.reviews) {
    return action("search_reviews", { listing_id: state.listingId, topics: state.intent, top_k: reviewRetrievalLimit(state) }, "Guest reviews are the primary evidence source.", "Review evidence is missing.");
  }

  if (needsGooglePlaces(state) && !state.places) {
    return action("get_google_places", { listing_id: state.listingId, radius_km: 2 }, "Location or nearby-context intent requires environmental context.", "Google Places context is missing.");
  }

  if (!state.signals) {
    return action("detect_guest_signals", { listing_id: state.listingId }, "The agent has observations and must decide whether an editable gap exists.", "Guest signals are missing.");
  }

  if (needsManagerRecommendations(state) && !state.managerRecommendations) {
    return action("draft_manager_recommendations", { listing_id: state.listingId }, "The manager asked what property issues to fix, so the agent should turn review signals into operational recommendations.", "No manager recommendations exist.");
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
      const requestedName = extractRequestedListingName(state.prompt);
      if (requestedName && !namesCompatible(requestedName, listing.name)) {
        state.stopReason = `The selected listing id belongs to "${listing.name}", but the manager prompt mentions "${requestedName}". The agent stopped instead of editing a possibly wrong listing.`;
        steps.push(step("Listing Tools", "Validate that the selected listing matches the manager's named property.", JSON.stringify(actionRequest.tool_input), {
          found: true,
          name_match: false,
          listing_id: listing.id,
          selected_listing_name: listing.name,
          requested_listing_name: requestedName,
          safety_note: "The agent stopped before review retrieval, Google Places, Supervisor approval, or page update."
        }));
        return false;
      }

      state.page = getSimulatedListingPage(listing, state.currentDescriptionOverride);
      steps.push(step("Listing Tools", "Retrieve the selected listing and simulated page state.", JSON.stringify(actionRequest.tool_input), {
        found: true,
        name_match: true,
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

      const retrievalLimit = Math.max(reviewRetrievalLimit(state), state.requireMoreEvidence ? 48 : 12);
      const reviewResult = await getReviewSearchResult(
        state.listing.id,
        reviewQueryForIntent(state.listing, state.intent),
        retrievalLimit
      );
      const reviews = reviewResult.reviews;
      const relevantReviews = searchRelevantReviews(reviews, state.intent, reviewRetrievalLimit(state));
      const indexedReviewTextCount = await getReviewTextCountForListing(state.listing.id);
      state.reviews = reviews;
      state.reviewSource = reviewResult.source;
      state.indexedReviewTextCount = indexedReviewTextCount;
      state.relevantReviews = relevantReviews;
      steps.push(step("Review RAG", "Retrieve Airbnb guest reviews for the selected listing.", JSON.stringify(actionRequest.tool_input), {
        listing_id: state.listing.id,
        source: reviewResult.source,
        indexed_review_texts_available: indexedReviewTextCount,
        retrieved_review_count: reviews.length,
        relevant_review_count: relevantReviews.length,
        top_k_requested: retrievalLimit,
        total_reviews_available: indexedReviewTextCount,
        retrieved_reviews: relevantReviews.map((review) => ({
          review_id: review.id,
          listing_id: review.listingId,
          date: review.date,
          excerpt: excerpt(review.comments)
        })),
        retrieval_note:
          reviewResult.source === "pinecone"
            ? "Pinecone searches the full review namespace filtered by listing_id, then returns the most relevant reviews for the current action."
            : "The local CSV fallback filters all prepared review texts by listing_id, then returns a bounded relevant sample for the current action."
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
      if (!state.listing || !state.reviews) {
        throw new Error("Cannot detect guest signals before listing reviews are retrieved.");
      }

      state.signals = detectSignals(
        state.listing,
        state.page?.currentDescription ?? state.listing.description,
        state.reviews,
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
      if (!state.listing) {
        throw new Error("Cannot draft an edit before listing data is loaded.");
      }

      if (isRestoreRequest(state)) {
        const proposal = EditProposalSchema.parse({
          action: "restore_original_page",
          target_fields: ["description"],
          listing_id: state.listing.id,
          proposed_description_addition: null,
          evidence_topics: ["Restore original dataset state"],
          reason: "The manager rejected the simulated edit and asked to return the listing page to its original dataset text."
        });
        state.proposal = proposal;
        steps.push(step("Edit & Decision Tools", "Draft a controlled restore action for the simulated listing page.", JSON.stringify(actionRequest.tool_input), {
          proposed_action: proposal,
          restore_source: "Original Airbnb listing row from the prepared dataset",
          editable_scope: "Simulated page description only"
        }));
        return true;
      }

      if (!state.signals) {
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

    case "draft_manager_recommendations": {
      if (!state.listing || !state.reviews || !state.signals) {
        throw new Error("Cannot draft manager recommendations before listing reviews and guest signals are available.");
      }

      state.managerRecommendations = draftManagerRecommendations(state.listing, state.reviews, state.signals);
      steps.push(step("Manager Insight Tools", "Draft property improvement recommendations from read-only guest reviews.", JSON.stringify(actionRequest.tool_input), {
        listing_id: state.listing.id,
        recommendations: state.managerRecommendations,
        editable_scope: "No page update is executed by this tool.",
        token_safety: "The tool uses already retrieved review observations and does not call live Airbnb, pricing, booking, or private-message systems."
      }));
      return false;
    }

    case "draft_evidence_report": {
      if (!state.listing || !state.reviews) {
        throw new Error("Cannot draft an evidence report before listing reviews are retrieved.");
      }

      state.evidenceReport = draftEvidenceReport(state);
      steps.push(step("Review RAG", "Draft a manager-facing evidence report without editing the simulated listing page.", JSON.stringify(actionRequest.tool_input), {
        evidence_report: state.evidenceReport,
        editable_scope: "No page update is executed by this tool.",
        token_safety: "The tool uses retrieved review observations only; it does not call Google Places, Supervisor, or page-update tools."
      }));
      return false;
    }

    case "restore_original_page": {
      if (!state.listing) {
        throw new Error("Cannot restore the page before listing data is loaded.");
      }

      const proposal = EditProposalSchema.parse({
        action: "restore_original_page",
        target_fields: ["description"],
        listing_id: state.listing.id,
        proposed_description_addition: null,
        evidence_topics: ["Restore original dataset state"],
        reason: "The manager rejected the simulated edit and asked to return the listing page to its original dataset text."
      });
      state.proposal = proposal;
      steps.push(step("Edit & Decision Tools", "Restore the simulated listing page from the original read-only dataset text.", JSON.stringify(actionRequest.tool_input), {
        proposed_action: proposal,
        restore_source: "Original Airbnb listing row from the prepared dataset",
        editable_scope: "Simulated page description only"
      }));
      return true;
    }

    case "submit_to_supervisor": {
      if (!state.proposal || (!state.signals && state.proposal.action !== "restore_original_page")) {
        throw new Error("Cannot submit to Supervisor before an edit proposal exists.");
      }

      const guardrails = validateProposal(state.proposal, state);
      const signals = state.signals ?? [];
      const fallbackSupervisor = supervise(state.proposal, signals, guardrails.passed);
      const supervisorDraft = await callLlmJson<SupervisorOutput>({
        module: "Supervisor / Control Agent",
        messages: [
          { role: "system", content: SUPERVISOR_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ proposal: state.proposal, signals, guardrails }) }
        ],
        mockResponse: fallbackSupervisor
      });
      const normalizedSupervisor = normalizeSupervisorOutput(supervisorDraft);
      const parsedSupervisor = SupervisorOutputSchema.safeParse(normalizedSupervisor);
      const llmOutputValid = parsedSupervisor.success;
      const safeSupervisor = parsedSupervisor.success
        ? parsedSupervisor.data
        : {
            ...fallbackSupervisor,
            rationale: `${fallbackSupervisor.rationale} LLM Supervisor output failed runtime validation, so deterministic Supervisor policy was used.`
          };
      state.supervisor = SupervisorOutputSchema.parse(enforceGuardrails(state.proposal, safeSupervisor, state));

      steps.push(step("Supervisor / Control Agent", SUPERVISOR_SYSTEM_PROMPT, JSON.stringify({ proposal: state.proposal, signals, guardrails }), {
        ...state.supervisor,
        guardrails: {
          ...guardrails,
          llm_output_valid: llmOutputValid
        }
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
  const explicit = prompt.match(/selected listing id:\s*(\d{5,})/i);
  if (explicit?.[1]) {
    return explicit[1];
  }

  const fallback = prompt.match(/\b\d{5,}\b/);
  return fallback?.[0] ?? null;
}

function extractRequestedListingName(prompt: string): string | null {
  const match = prompt.match(/\b(?:handle|review|restore|for|on)\s+["']([^"']{4,140})["']/i);
  return match?.[1]?.trim() ?? null;
}

function namesCompatible(requested: string, selected: string): boolean {
  const requestedNormalized = normalizeName(requested);
  const selectedNormalized = normalizeName(selected);

  if (!requestedNormalized || !selectedNormalized) {
    return true;
  }

  if (selectedNormalized.includes(requestedNormalized) || requestedNormalized.includes(selectedNormalized)) {
    return true;
  }

  const requestedTokens = new Set(requestedNormalized.split(" ").filter((token) => token.length > 2));
  const selectedTokens = new Set(selectedNormalized.split(" ").filter((token) => token.length > 2));
  const overlap = [...requestedTokens].filter((token) => selectedTokens.has(token)).length;
  const denominator = Math.max(requestedTokens.size, selectedTokens.size, 1);
  return overlap / denominator >= 0.55;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferIntent(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const topics = Object.entries(topicKeywords)
    .filter(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)))
    .map(([topic]) => topic);

  if (isEvidenceOnlyPrompt(prompt)) {
    return Array.from(
      new Set([
        "evidence_search",
        ...topics.filter((topic) => !["review_alignment", "nearby_highlights", "restore_original"].includes(topic))
      ])
    );
  }

  const broadReviewRequest =
    /\b(end to end|autonomously review|all managed|improve|gap|gaps|guest reviews|reviews and nearby|חוויית|ביקורות|פער|פערים|תשפר|תערוך)\b/i.test(prompt);

  if (broadReviewRequest) {
    return Array.from(
      new Set([
        "review_alignment",
        "location",
        "hills",
        "stairs",
        "noise",
        "wifi",
        "cleanliness",
        "comfort",
        "temperature",
        "view",
        "space",
        "nearby_highlights",
        ...topics
      ])
    );
  }

  if (topics.length > 0) {
    return topics;
  }

  return ["review_alignment", "location", "hills", "stairs", "noise", "wifi", "comfort", "temperature", "view"];
}

function isEvidenceOnlyPrompt(prompt: string): boolean {
  return /\b(find|show|get|retrieve|bring|look for|can you find)\b.{0,45}\b(more\s+)?(evidence|evidance|avidance|proof|examples?|review signals?|guest signals?)\b/i.test(prompt) ||
    /\b(more\s+)?(evidence|evidance|avidance|proof|examples?)\s+(for|about|of|to)\b/i.test(prompt) ||
    /עוד\s+(עדויות|ראיות|דוגמאות)|תמצא\s+עוד|הוכחות/i.test(prompt);
}

function reviewRetrievalLimit(state: AgentState): number {
  if (state.requireMoreEvidence) {
    return 48;
  }

  if (needsEvidenceReport(state)) {
    return 48;
  }

  if (state.intent.includes("review_alignment")) {
    return 36;
  }

  return 16;
}

function reviewQueryForIntent(listing: Listing, intent: string[]): string {
  const topics = intent
    .filter((topic) => !["review_alignment", "restore_original", "evidence_search"].includes(topic))
    .slice(0, 8)
    .join(", ");

  return [
    `Lisbon Airbnb guest reviews for listing ${listing.id}: ${listing.name}.`,
    topics ? `Find review evidence about ${topics}.` : "Find repeated guest experience signals.",
    "Prefer concrete guest experience details over generic praise."
  ].join(" ");
}

function needsGooglePlaces(state: AgentState): boolean {
  if (needsManagerRecommendations(state)) {
    return false;
  }

  return (
    state.intent.includes("location") ||
    state.intent.includes("noise") ||
    state.intent.includes("nearby_highlights") ||
    state.intent.includes("hills")
  );
}

function needsManagerRecommendations(state: AgentState): boolean {
  return state.intent.includes("property_fixes");
}

function needsEvidenceReport(state: AgentState): boolean {
  return state.intent.includes("evidence_search");
}

function extractClaims(listing: Listing, currentDescription: string): Record<string, unknown> {
  const description = currentDescription.toLowerCase();
  return {
    mentions_quiet: description.includes("quiet"),
    mentions_nightlife: description.includes("nightlife") || description.includes("entertainment"),
    mentions_hills: description.includes("hill") || description.includes("steep"),
    mentions_stairs: description.includes("stairs") || description.includes("steps") || description.includes("elevator") || description.includes("lift"),
    mentions_wifi: description.includes("wifi") || listing.amenities.some((amenity) => amenity.toLowerCase().includes("wifi")),
    mentions_temperature:
      description.includes("warm") ||
      description.includes("hot") ||
      description.includes("air conditioning") ||
      description.includes("heating"),
    mentions_view: description.includes("view") || description.includes("river") || description.includes("terrace") || description.includes("balcony"),
    mentions_cleanliness: description.includes("clean") || description.includes("spotless"),
    mentions_comfort: description.includes("comfortable") || description.includes("comfy") || description.includes("bed"),
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
    return rankGuestValuablePlaces(places, 8);
  }

  if (intent.includes("noise")) {
    return places.filter((place) => /bar|restaurant|night|cafe/i.test(`${place.category} ${place.placeName}`)).slice(0, 5);
  }

  return rankGuestValuablePlaces(places, 6);
}

function isGuestValuablePlace(place: Place): boolean {
  const text = `${place.category} ${place.placeName}`.toLowerCase();
  const guestFacingCategory = /culture|parks_recreation|dining|wellness_lifestyle|nightlife/.test(text);
  const notUsefulForListingCopy = /storage|luggage|facility|atm|bank|real estate|school|clinic|pharmacy|parking/i.test(text);
  return guestFacingCategory && !notUsefulForListingCopy && (place.rating ?? 0) >= 4.4 && place.numberOfReviews >= 40;
}

function rankGuestValuablePlaces(places: Place[], limit: number): Place[] {
  const filtered = places.filter(isGuestValuablePlace);
  const coreGuestPlaces = filtered.filter((place) => !/Wellness_Lifestyle/i.test(place.category));
  const candidates = coreGuestPlaces.length >= Math.min(3, limit) ? coreGuestPlaces : filtered;
  return candidates.sort((a, b) => guestPlaceScore(b) - guestPlaceScore(a)).slice(0, limit);
}

function guestPlaceScore(place: Place): number {
  const category = place.category.toLowerCase();
  const categoryBoost =
    category.includes("dining") || category.includes("culture") || category.includes("parks_recreation")
      ? 3
      : category.includes("nightlife")
        ? 1.2
        : 0.4;
  const rating = place.rating ?? 0;
  const reviewWeight = Math.log10(place.numberOfReviews + 10);
  const distancePenalty = Math.min(place.distanceKm ?? 2, 2) * 0.25;
  return rating * reviewWeight + categoryBoost - distancePenalty;
}

function formatPlaceForGuestCopy(place: Place): string {
  const rating = place.rating ? `${place.rating.toFixed(1)}/5` : "highly rated";
  const reviews = place.numberOfReviews > 0 ? `, ${place.numberOfReviews} Google reviews` : "";
  const distance = approximateDistance(place.distanceKm);
  return `${place.placeName} (${rating}${reviews}${distance})`;
}

function approximateDistance(distanceKm?: number): string {
  if (typeof distanceKm !== "number" || !Number.isFinite(distanceKm)) {
    return "";
  }

  if (distanceKm < 0.25) {
    return ", about a few minutes away";
  }

  if (distanceKm < 1) {
    return `, about ${Math.round(distanceKm * 10) / 10} km away`;
  }

  return `, about ${Math.round(distanceKm)} km away`;
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
  const hasBroadIntent = intent.includes("review_alignment");

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

  if (intent.includes("stairs") || reviewText.includes("stairs") || reviewText.includes("steps")) {
    const evidence = reviews
      .filter((review) => /stairs|steps|elevator|lift/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 2 && !description.includes("stairs") && !description.includes("steps") && !description.includes("elevator")) {
      signals.push({
        type: "accuracy_gap",
        topic: "Access and stairs expectations",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add an expectation-setting note about stairs or access when guests repeatedly mention it."
      });
    }
  }

  if (intent.includes("noise") || /\b(noise|noisy|loud|nightlife|bar|bars)\b/i.test(reviewText)) {
    const evidence = reviews
      .filter((review) => /\b(noisy|loud|nightlife|bar|bars)\b|busy street|weekend nights/i.test(review.comments))
      .filter((review) => !/\b(no issues with noise|not noisy|very quiet|quiet stay)\b/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 2 && (description.includes("quiet") || hasBroadIntent)) {
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

  if (intent.includes("temperature") || /\b(hot|warm|cold|heating|heater)\b|air conditioning|a\/c/i.test(reviewText)) {
    const evidence = reviews
      .filter((review) => /\b(hot|warm|cold|heating|heater)\b|air conditioning|a\/c|\bac\b/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (
      evidence.length >= 2 &&
      !description.includes("hot") &&
      !description.includes("warm") &&
      !description.includes("temperature")
    ) {
      signals.push({
        type: "accuracy_gap",
        topic: "Temperature expectations",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add a careful expectation note when guests repeatedly mention room temperature."
      });
    }
  }

  if (intent.includes("space") || /small|tiny|compact|cramped/i.test(reviewText)) {
    const evidence = reviews
      .filter((review) => /small|tiny|compact|cramped/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 2 && !description.includes("compact") && !description.includes("small")) {
      signals.push({
        type: "accuracy_gap",
        topic: "Space expectations",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add a concise expectation-setting note about the space being compact if guests repeatedly mention it."
      });
    }
  }

  if (intent.includes("location") || hasBroadIntent) {
    const evidence = reviews
      .filter((review) => /location|walk|walking|metro|tram|central|close|near/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 3 && !description.includes("guests often mention") && !description.includes("guest location note")) {
      signals.push({
        type: "guest_experience_detail",
        topic: "Guest-confirmed walkable location",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add a review-backed location note instead of relying only on generic area wording."
      });
    }
  }

  if (intent.includes("view") || /view|views|river|terrace|balcony/i.test(reviewText)) {
    const evidence = reviews
      .filter((review) => /view|views|river|terrace|balcony/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 2 && !description.includes("guest view note") && !description.includes("guests mention the view")) {
      signals.push({
        type: "guest_experience_detail",
        topic: "Guest-mentioned view",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add a guest-backed note about the view when it is repeatedly mentioned."
      });
    }
  }

  if (intent.includes("cleanliness") || /clean|spotless/i.test(reviewText)) {
    const evidence = reviews
      .filter((review) => /clean|spotless|well kept|tidy/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 3 && !description.includes("guest cleanliness note") && !description.includes("guests repeatedly describe")) {
      signals.push({
        type: "guest_experience_detail",
        topic: "Guest-confirmed cleanliness",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add a modest cleanliness note backed by repeated guest reviews."
      });
    }
  }

  if (intent.includes("comfort") || /comfortable|comfy|bed/i.test(reviewText)) {
    const evidence = reviews
      .filter((review) => /comfortable|comfy|bed|sleep/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 3 && !description.includes("guest comfort note") && !description.includes("comfortable stay")) {
      signals.push({
        type: "guest_experience_detail",
        topic: "Guest-confirmed comfort",
        evidenceCount: evidence.length,
        primaryEvidenceCount: evidence.length,
        evidence,
        recommendation: "Add a restrained comfort note when guests repeatedly mention it."
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

  if ((intent.includes("nearby_highlights") || hasBroadIntent) && places.length >= 2 && !description.includes("nearby highlights")) {
    const topPlaces = places.slice(0, 3);
    const reviewSupport = reviews.filter((review) => /nearby|restaurant|park|cafe|attraction|location/i.test(review.comments));
    if (reviewSupport.length >= 2) {
      signals.push({
        type: "positive_highlight",
        topic: "Rated nearby guest options",
        evidenceCount: places.length + reviewSupport.length,
        primaryEvidenceCount: reviewSupport.length,
        evidence: [...reviewSupport.slice(0, 2).map((review) => excerpt(review.comments)), ...topPlaces.map(formatPlaceForGuestCopy)],
        recommendation: "Add a concise nearby highlights note using guest location comments plus high-quality Google Places rating context."
      });
    }
  }

  if ((intent.includes("nearby_highlights") || hasBroadIntent) && !description.includes("nearby dining")) {
    const diningPlaces = places
      .filter((place) => /Dining|restaurant|food|cafe|seafood|pizza|bar/i.test(`${place.category} ${place.placeName}`))
      .filter((place) => (place.rating ?? 0) >= 4.5 && place.numberOfReviews >= 30)
      .slice(0, 3);
    const diningReviewSupport = reviews.filter((review) => /restaurant|restaurants|cafe|cafes|eating|food|bar|bars/i.test(review.comments));
    if (diningPlaces.length >= 1 && diningReviewSupport.length >= 2) {
      signals.push({
        type: "positive_highlight",
        topic: "Rated nearby dining options",
        evidenceCount: diningPlaces.length + diningReviewSupport.length,
        primaryEvidenceCount: diningReviewSupport.length,
        evidence: [
          ...diningReviewSupport.slice(0, 2).map((review) => excerpt(review.comments)),
          ...diningPlaces.map(formatPlaceForGuestCopy)
        ],
        recommendation: "Add nearby dining options only when Airbnb reviews support the area value and Google Places provides rating context."
      });
    }
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
  const editableSignals = signals
    .filter((signal) => signal.type !== "insufficient_evidence" && signal.primaryEvidenceCount >= 2)
    .sort((a, b) => signalPriority(a) - signalPriority(b));

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

  const selectedSignals = selectSignalsForEdit(editableSignals);
  const additions = selectedSignals.map((signal) => {
    if (signal.topic === "Historic Lisbon hills") {
      return "A great fit for guests who want to explore historic Lisbon on foot; some nearby streets are steep, so comfortable walking shoes are recommended.";
    }
    if (signal.topic === "Access and stairs expectations") {
      return "Best suited for guests who are comfortable with stairs or stepped access, a detail previous guests mention and appreciate knowing before arrival.";
    }
    if (signal.topic === "Noise expectations") {
      return "This stay suits guests who enjoy being close to Lisbon's lively center; as in many central neighborhoods, some street activity may be part of the experience.";
    }
    if (signal.topic === "Temperature expectations") {
      return "During warmer Lisbon periods, guests who prefer cooler rooms may want to plan accordingly; this note helps set the right comfort expectations before booking.";
    }
    if (signal.topic === "Space expectations") {
      return "The space is best for travelers who value a smart central base over extra room, with guest reviews pointing to location and convenience as the main strengths.";
    }
    if (signal.topic === "Guest-confirmed walkable location") {
      return "Guests consistently highlight the walkable central location, making it easy to reach Lisbon sights, restaurants, and transport without planning every outing around a car.";
    }
    if (signal.topic === "Guest-mentioned view") {
      return "The view is one of the stay's guest-mentioned highlights, adding a memorable Lisbon backdrop to the visit.";
    }
    if (signal.topic === "Guest-confirmed cleanliness") {
      return "Reviews repeatedly describe the place as clean and well kept, which helps guests book with more confidence.";
    }
    if (signal.topic === "Guest-confirmed comfort") {
      return "Guests repeatedly mention a comfortable stay and good sleep experience, making the property a strong fit after full days exploring Lisbon.";
    }
    if (signal.topic === "Remote-work readiness") {
      return "For guests mixing travel with work, reviews and listed amenities support a practical short remote-work setup.";
    }
    if (signal.topic === "Rated nearby guest options") {
      const places = signal.evidence.filter(isFormattedGooglePlace).slice(-3);
      return `Guest location reviews support highlighting the surrounding area, with highly rated nearby options such as ${places.join(", ")}.`;
    }
    if (signal.topic === "Rated nearby dining options") {
      const places = signal.evidence.filter(isFormattedGooglePlace).slice(-3);
      return `Guests mention the convenience of nearby places to eat, and Google Places context supports that with highly rated nearby dining options such as ${places.join(", ")}.`;
    }
    return signal.recommendation;
  });

  return {
    action: "prepare_edit_proposal",
    target_fields: ["description"],
    listing_id: listing.id,
    proposed_description_addition: additions.join(" "),
    evidence_topics: selectedSignals.map((signal) => signal.topic)
  };
}

function selectSignalsForEdit(signals: Signal[]): Signal[] {
  const selected = signals.slice(0, 3);
  const nearbySignal = signals.find(
    (signal) => signal.topic === "Rated nearby guest options" || signal.topic === "Rated nearby dining options"
  );

  if (nearbySignal && !selected.includes(nearbySignal)) {
    selected.push(nearbySignal);
  }

  return selected.slice(0, 4);
}

function isFormattedGooglePlace(value: string): boolean {
  return /\bGoogle reviews\b/i.test(value) || /\b\/5\b/i.test(value);
}

function signalPriority(signal: Signal): number {
  if (signal.type === "accuracy_gap") {
    return 0;
  }

  if (signal.type === "guest_experience_detail") {
    return 1;
  }

  if (signal.topic === "Rated nearby guest options") {
    return 3;
  }

  if (signal.topic === "Rated nearby dining options") {
    return 2;
  }

  return 2;
}

function draftManagerRecommendations(
  listing: Listing,
  reviews: Review[],
  signals: Signal[]
): ManagerRecommendation[] {
  const candidates = [
    recommendationCandidate(
      "Temperature comfort",
      "high",
      reviews,
      /\b(hot|warm|cold|heating|heater)\b|air conditioning|a\/c|\bac\b/i,
      "Guests mention temperature comfort.",
      "Check cooling/heating, ventilation, and simple comfort items such as an extra fan or clearer seasonal instructions.",
      "Reducing temperature discomfort can improve sleep quality, review scores, and guest satisfaction."
    ),
    recommendationCandidate(
      "Access and stairs",
      "medium",
      reviews,
      /stairs|steps|elevator|lift|climb/i,
      "Guests mention stairs, stepped access, elevator availability, or luggage handling.",
      "Improve pre-arrival access instructions, highlight luggage expectations, and consider practical support such as clearer check-in guidance.",
      "Clearer access handling reduces surprise on arrival and helps guests self-select before booking.",
      1
    ),
    recommendationCandidate(
      "Noise management",
      "medium",
      reviews,
      /\b(noisy|loud|nightlife|bar|bars)\b|busy street|weekend nights/i,
      "Guests mention noise or active street conditions.",
      "Consider better window sealing, earplugs, quiet-hours guidance, or clearer expectation-setting in the page description.",
      "Better noise management lowers expectation mismatch and can prevent avoidable negative reviews."
    ),
    recommendationCandidate(
      "Wi-Fi reliability",
      "high",
      reviews,
      /wifi|wi-fi|internet|connection|remote work/i,
      "Guests mention Wi-Fi, internet, or remote-work needs.",
      "Test connection reliability, document router instructions, and make the workspace setup clear if the amenity is offered.",
      "Reliable connectivity is a high-value factor for business travelers and longer stays."
    ),
    recommendationCandidate(
      "Cleaning consistency",
      "high",
      reviews,
      /dirty|dust|smell|odor|unclean|not clean/i,
      "Guests mention cleanliness issues.",
      "Review cleaning checklist, inspect high-touch areas, and track recurring cleaning complaints before each turnover.",
      "Cleaning consistency directly affects review scores, trust, and conversion."
    ),
    recommendationCandidate(
      "Sleep comfort",
      "medium",
      reviews,
      /uncomfortable|hard bed|soft bed|mattress|pillow|sleep/i,
      "Guests mention bed or sleep comfort.",
      "Inspect mattress, pillows, linens, and light/noise conditions that affect sleep.",
      "Better sleep experience improves perceived value and repeat-booking potential."
    ),
    recommendationCandidate(
      "Space expectations",
      "low",
      reviews,
      /small|tiny|compact|cramped/i,
      "Guests describe the space as compact.",
      "Improve storage, declutter visible areas, and keep page wording clear about efficient space usage.",
      "Matching expectations reduces disappointment while preserving the property's location value.",
      1
    ),
    recommendationCandidate(
      "Coffee and hot-drink basics",
      "medium",
      reviews,
      /coffee machine|hot water|make coffee|coffee|cafe next door/i,
      "Guests mention coffee or hot-drink access as a small but fixable convenience gap.",
      "Consider adding a kettle, coffee machine, or clearer note about nearby cafe options if in-room coffee is not provided.",
      "Small comfort upgrades can improve perceived hospitality and reduce minor friction in otherwise positive stays.",
      1
    ),
    recommendationCandidate(
      "Early check-in reliability",
      "low",
      reviews,
      /early check.?in|check in.*dependable|not quite dependable|drop off luggage|luggage storage/i,
      "Guests mention early check-in or luggage handling expectations.",
      "Clarify when early check-in is confirmed versus optional, and keep luggage-storage instructions visible before arrival.",
      "Clearer arrival expectations reduce friction at the start of the stay and protect the host's service score.",
      1
    )
  ].filter((item): item is ManagerRecommendation => Boolean(item));

  const signalBacked = signals
    .filter((signal) => signal.type === "accuracy_gap" && signal.primaryEvidenceCount >= 2)
    .map((signal) => signalToRecommendation(signal))
    .filter((item): item is ManagerRecommendation => Boolean(item));

  const merged = [...signalBacked, ...candidates].filter(
    (item, index, items) => items.findIndex((candidate) => candidate.topic === item.topic) === index
  );

  if (merged.length > 0) {
    return merged.slice(0, 4);
  }

  return [
    {
      topic: "No repeated fixable issue found",
      priority: "low",
      guestSignal: "The prepared review sample does not show a repeated operational complaint for this listing.",
      suggestedAction: "Keep monitoring new guest feedback and use the page-edit tool if a review-backed expectation gap appears.",
      businessValue: "Avoiding unsupported changes protects listing accuracy and prevents token waste.",
      evidenceCount: reviews.length,
      evidence: reviews.slice(0, 2).map((review) => excerpt(review.comments))
    }
  ];
}

function draftEvidenceReport(state: AgentState): EvidenceReport {
  const reviews = state.reviews ?? [];
  const topic = evidenceReportTopic(state.intent, state.prompt);
  const pattern = evidencePatternForIntent(state.intent, state.prompt);
  const matchingReviews = reviews.filter((review) => pattern.test(review.comments));
  const fallbackReviews = state.relevantReviews?.length ? state.relevantReviews : reviews;
  const evidenceReviews = (matchingReviews.length > 0 ? matchingReviews : fallbackReviews).slice(0, 8);
  const matchingEvidenceCount = matchingReviews.length > 0 ? matchingReviews.length : evidenceReviews.length;

  return {
    listingId: state.listing!.id,
    listingName: state.listing!.name,
    topic,
    source: state.reviewSource ?? "csv_fallback",
    indexedReviewTextCount: state.indexedReviewTextCount ?? state.listing!.numberOfReviews,
    retrievedReviewCount: reviews.length,
    matchingEvidenceCount,
    evidence: evidenceReviews.map((review) => `${review.date || "undated"}: ${excerpt(review.comments)}`),
    conclusion:
      matchingEvidenceCount > 0
        ? `Found ${matchingEvidenceCount} matching review examples in the retrieved evidence sample for ${topic}. This is evidence collection only, so the simulated listing page was not edited.`
        : `No additional matching examples were found in the retrieved evidence sample for ${topic}. The simulated listing page was not edited.`
  };
}

function evidenceReportTopic(intent: string[], prompt: string): string {
  if (intent.includes("wifi") || /wi-?fi|internet|connection|remote.?work/i.test(prompt)) {
    return "Wi-Fi reliability";
  }
  if (intent.includes("noise")) return "Noise expectations";
  if (intent.includes("temperature")) return "Temperature comfort";
  if (intent.includes("stairs")) return "Access and stairs";
  if (intent.includes("hills")) return "Historic Lisbon hills";
  if (intent.includes("space")) return "Space expectations";
  if (intent.includes("cleanliness")) return "Cleanliness";
  if (intent.includes("comfort")) return "Sleep and comfort";
  if (intent.includes("location")) return "Location and walkability";
  return "requested guest-review signal";
}

function evidencePatternForIntent(intent: string[], prompt: string): RegExp {
  if (intent.includes("wifi") || /wi-?fi|internet|connection|remote.?work/i.test(prompt)) {
    return /wifi|wi-fi|internet|connection|router|remote work|work remotely/i;
  }
  if (intent.includes("noise")) {
    return /\b(noisy|noise|loud|nightlife|bar|bars)\b|busy street|weekend nights/i;
  }
  if (intent.includes("temperature")) {
    return /\b(hot|warm|cold|heating|heater)\b|air conditioning|a\/c|\bac\b/i;
  }
  if (intent.includes("stairs")) {
    return /stairs|steps|elevator|lift/i;
  }
  if (intent.includes("hills")) {
    return /hill|steep|walk up|climb/i;
  }
  if (intent.includes("space")) {
    return /small|tiny|compact|cramped/i;
  }
  if (intent.includes("cleanliness")) {
    return /clean|spotless|well kept|tidy|dirty|dust|smell|odor/i;
  }
  if (intent.includes("comfort")) {
    return /comfortable|comfy|bed|mattress|pillow|sleep/i;
  }
  if (intent.includes("location")) {
    return /location|walk|walking|metro|tram|central|close|near/i;
  }
  return /./i;
}

function recommendationCandidate(
  topic: string,
  priority: ManagerRecommendation["priority"],
  reviews: Review[],
  pattern: RegExp,
  guestSignal: string,
  suggestedAction: string,
  businessValue: string,
  minEvidence = 2
): ManagerRecommendation | null {
  const evidence = reviews.filter((review) => pattern.test(review.comments)).map((review) => excerpt(review.comments));

  if (evidence.length < minEvidence) {
    return null;
  }

  return {
    topic,
    priority,
    guestSignal: evidence.length >= 2 ? guestSignal : `${guestSignal} This appears in the prepared review sample and should be treated as a practical watchlist item rather than a repeated complaint.`,
    suggestedAction,
    businessValue,
    evidenceCount: evidence.length,
    evidence: evidence.slice(0, 3)
  };
}

function signalToRecommendation(signal: Signal): ManagerRecommendation | null {
  if (signal.topic === "Historic Lisbon hills") {
    return {
      topic: "Hills and walking effort",
      priority: "medium",
      guestSignal: "Guests repeatedly mention steep nearby walks.",
      suggestedAction: "Make access guidance clearer before arrival and suggest the easiest route or nearby transport option.",
      businessValue: "Better expectation-setting reduces arrival friction while keeping the historic-location value clear.",
      evidenceCount: signal.primaryEvidenceCount,
      evidence: signal.evidence.slice(0, 3)
    };
  }

  if (signal.topic === "Access and stairs expectations") {
    return {
      topic: "Access and stairs",
      priority: "medium",
      guestSignal: "Guests repeatedly mention stairs or stepped access.",
      suggestedAction: "Improve pre-arrival access instructions and clarify luggage expectations.",
      businessValue: "Clear access expectations reduce avoidable disappointment and support better reviews.",
      evidenceCount: signal.primaryEvidenceCount,
      evidence: signal.evidence.slice(0, 3)
    };
  }

  if (signal.topic === "Temperature expectations") {
    return {
      topic: "Temperature comfort",
      priority: "high",
      guestSignal: "Guests repeatedly mention room temperature.",
      suggestedAction: "Check cooling/heating, ventilation, and seasonal comfort guidance.",
      businessValue: "Comfort improvements can directly improve review quality and perceived value.",
      evidenceCount: signal.primaryEvidenceCount,
      evidence: signal.evidence.slice(0, 3)
    };
  }

  return null;
}

function normalizeSupervisorOutput(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const draft = value as Record<string, unknown>;
  const decisionValue = String(draft.decision ?? "").trim().toLowerCase();
  const decision =
    decisionValue === "approve" || decisionValue === "approved"
      ? "Approve"
      : decisionValue === "revise" || decisionValue === "revision_requested"
        ? "Revise"
        : decisionValue === "block" || decisionValue === "blocked"
          ? "Block"
          : draft.decision;

  return {
    ...draft,
    decision,
    rationale: typeof draft.rationale === "string" ? draft.rationale : draft.reason
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

  if (proposal.action === "restore_original_page") {
    return {
      decision: "Approve",
      rationale: "The action restores the simulated listing page to the original read-only dataset text and does not modify reviews, Places data, pricing, or live Airbnb."
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

  if (state.managerRecommendations) {
    return managerRecommendationResponse(state.listing, state.managerRecommendations);
  }

  if (state.evidenceReport) {
    return evidenceReportResponse(state.evidenceReport);
  }

  if (state.supervisor?.decision === "Approve" && state.pageUpdate?.status === "executed") {
    if (state.proposal?.action === "restore_original_page") {
      return [
        `Approved and executed in the demo environment for listing ${state.listing.id}: ${state.listing.name}.`,
        "",
        "The simulated listing description was restored to the original dataset text.",
        "",
        "No source CSV, guest review, Google Places row, or live Airbnb account was changed. The restore action was recorded in the audit log."
      ].join("\n");
    }

    return [
      `Approved and executed in the demo environment for listing ${state.listing.id}: ${state.listing.name}.`,
      "",
      `What changed: the agent updated the ${state.pageUpdate.field} with this evidence-backed text:`,
      state.pageUpdate.addedText,
      "",
      `Why this improves the page: ${pageEditBenefit(state)}`,
      "",
      `Evidence used: ${pageEditEvidenceSummary(state)}`,
      "",
      "No live Airbnb account was accessed. The update was applied only to the simulated listing page and recorded in the audit log."
    ].join("\n");
  }

  if (state.supervisor?.decision === "Revise") {
    return `The Supervisor requested revision for listing ${state.listing.id}. The agent replanned once and stopped because a safe approved edit was not available. No live Airbnb account was accessed.`;
  }

  if (state.stopReason) {
    return `${state.stopReason} No live Airbnb account was accessed, and no simulated page update was executed.`;
  }

  return `No action was taken for listing ${state.listing.id}. The agent did not find enough validated evidence for a safe page update. No live Airbnb account was accessed.`;
}

function pageEditBenefit(state: AgentState): string {
  const topics = state.proposal?.evidence_topics ?? [];

  if (topics.some((topic) => /stairs|hills|temperature|noise|space/i.test(topic))) {
    return "it sets clearer guest expectations before booking, which reduces surprise during the stay and can prevent avoidable negative reviews.";
  }

  if (topics.some((topic) => /view|cleanliness|comfort|location|nearby/i.test(topic))) {
    return "it makes the listing more persuasive by surfacing strengths that guests repeatedly mention, without inventing unsupported claims.";
  }

  return "it aligns the page with repeated guest experience signals while keeping the source reviews and data read-only.";
}

function pageEditEvidenceSummary(state: AgentState): string {
  const topics = state.proposal?.evidence_topics ?? [];
  const strongestSignals = (state.signals ?? [])
    .filter((signal) => topics.includes(signal.topic))
    .map((signal) => `${signal.topic} (${signal.primaryEvidenceCount} guest-review signals)`);

  if (strongestSignals.length > 0) {
    return strongestSignals.join("; ");
  }

  return "Airbnb guest reviews were the primary evidence source; Google Places was used only as supporting context when relevant.";
}

function managerRecommendationResponse(listing: Listing, recommendations: ManagerRecommendation[]): string {
  const lines = [
    `Manager recommendations for listing ${listing.id}: ${listing.name}.`,
    "",
    "The agent did not edit the listing page. It used read-only guest reviews to identify fixable property or operations issues.",
    ""
  ];

  for (const recommendation of recommendations) {
    lines.push(
      `${recommendation.priority.toUpperCase()} | ${recommendation.topic}`,
      `Guest signal: ${recommendation.guestSignal} (${recommendation.evidenceCount} review signals).`,
      `Recommended action: ${recommendation.suggestedAction}`,
      `Why it helps: ${recommendation.businessValue}`,
      ""
    );
  }

  lines.push("No live Airbnb account, pricing, bookings, private messages, guest reviews, or source CSV rows were changed.");
  return lines.join("\n");
}

function evidenceReportResponse(report: EvidenceReport): string {
  const lines = [
    `Evidence report for listing ${report.listingId}: ${report.listingName}.`,
    "",
    `Topic checked: ${report.topic}.`,
    `Review source: ${report.source}. The search retrieved ${report.retrievedReviewCount} relevant reviews from ${report.indexedReviewTextCount} read-only indexed review texts for this listing.`,
    `Matching evidence found: ${report.matchingEvidenceCount} review examples.`,
    "",
    report.conclusion,
    ""
  ];

  if (report.evidence.length > 0) {
    lines.push("Review evidence examples:");
    for (const item of report.evidence) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push("No page edit, Supervisor approval, audit-log page update, Google Places lookup, live Airbnb access, pricing, bookings, private messages, guest reviews, or source CSV rows were changed.");
  return lines.join("\n");
}

function isRestoreRequest(state: AgentState): boolean {
  return state.intent.includes("restore_original");
}

function isPortfolioRequest(prompt: string): boolean {
  return /\b(all|every|portfolio|managed listings|managed properties|properties I manage|listings I manage)\b/i.test(prompt) ||
    /כל הנכסים|כל הדירות|כל הרשימות|בבעלותי|שבבעלותי/.test(prompt);
}

function portfolioPromptForListing(prompt: string, listingName: string): string {
  if (inferIntent(prompt).includes("restore_original")) {
    return `Restore "${listingName}" to the original dataset text if the simulated page was edited.`;
  }

  return [
    `For "${listingName}", autonomously review the current simulated Airbnb page against guest reviews and nearby context.`,
    "If there is an evidence-backed improvement, update only the allowed simulated listing-page text.",
    "If evidence is weak or the page is already aligned, stop without editing and explain why.",
    `Original manager request: ${prompt}`
  ].join(" ");
}

function selectedActionsFromSteps(steps: AgentStep[]): string[] {
  return steps
    .map((item) => (typeof (item.response as { next_action?: unknown })?.next_action === "string" ? (item.response as { next_action: string }).next_action : null))
    .filter((value): value is string => Boolean(value));
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
    deterministic_planner: Boolean(state.deterministicPlanner),
    has_listing: Boolean(state.listing),
    has_claims: Boolean(state.claims),
    has_review_observations: Boolean(state.relevantReviews),
    has_google_places_context: Boolean(state.relevantPlaces),
    has_signals: Boolean(state.signals),
    has_proposal: Boolean(state.proposal),
    supervisor_decision: state.supervisor?.decision,
    revise_count: state.reviseCount,
    runtime_observations: state.observations,
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
    portfolio_update: null,
    audit_log: null
  };
}

function excerpt(value: string, length = 220): string {
  return value.length > length ? `${value.slice(0, length).trim()}...` : value;
}
