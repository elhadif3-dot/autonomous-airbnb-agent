import {
  getListingById,
  getLocalReviewsForListing,
  getManagedDemoListings,
  getPlacesNearListing,
  getReviewSearchResult,
  getReviewTextCountForListing
} from "@/lib/data";
import { enforceGuardrails, validateProposal } from "@/lib/guardrails";
import { callLlmJsonWithTrace } from "@/lib/llmClient";
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
import {
  resetReviewCoverageForListing,
  selectNextReviewCoverageWindow
} from "@/lib/reviewCoverageStore";
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
  ReviewCoverageSnapshot,
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
  sessionId: string;
  currentDescriptionOverride?: string;
  previousDescriptionOverride?: string;
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
  reviewSearchStats?: ReviewSearchStats;
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
  reviewCoverageState?: ReviewCoverageSnapshot;
  nextReviewCoverageState?: ReviewCoverageSnapshot;
  rejectedTopics?: string[];
  reviseCount: number;
  requireMoreEvidence: boolean;
  stopReason?: string;
};

type ReviewSearchStats = {
  strategy: string;
  queriesRun: number;
  queryTopics: string[];
  topKPerQuery: number;
  targetUniqueReviews: number;
  maxUniqueReviews: number;
  coverageWindowSize: number;
  coverageScopeKey: string;
  coverageTotalReviewsInScope: number;
  coveragePreviouslyCoveredCount: number;
  coverageNewReviewsCount: number;
  coverageCoveredAfterCount: number;
  coverageComplete: boolean;
  timeBudgetMs: number;
  elapsedMs: number;
  stopReason: string;
};

const topicKeywords: Record<string, string[]> = {
  review_alignment: ["improve", "gap", "gaps", "align", "experience", "end to end"],
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
  nearby_highlights: ["restaurant", "park", "museum", "attraction", "cafe", "viewpoint", "nearby", "recommend"],
  restore_original: ["restore", "revert", "undo", "reset", "back to original", "previous version", "לא אהבתי", "חזור", "תחזיר", "בטל"],
  restore_previous: ["previous version", "previous text", "last version", "last edit", "one version back"],
  copy_polish: ["polish", "rewrite", "make natural", "more natural", "stronger copy", "marketing copy", "persuasive", "wording", "tone", "sell better"]
};

const MAX_ACTIONS = 16;
const MAX_PORTFOLIO_LISTINGS = 8;

export async function executeListingAgent(prompt: string): Promise<ExecuteResponse> {
  return executeListingAgentWithOptions(prompt, {});
}

type ExecuteOptions = {
  currentPageDescription?: string;
  previousPageDescription?: string;
  portfolioPageDescriptions?: Record<string, string>;
  reviewCoverageState?: ReviewCoverageSnapshot;
  sessionId?: string;
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
      return await executePortfolioAgent(
        prompt,
        steps,
        options.portfolioPageDescriptions ?? {},
        options.reviewCoverageState,
        options.sessionId ?? "api-default-session"
      );
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
      sessionId: options.sessionId ?? "api-default-session",
      currentDescriptionOverride: options.currentPageDescription,
      previousDescriptionOverride: options.previousPageDescription,
      reviewCoverageState: options.reviewCoverageState,
      intent: inferIntent(prompt),
      selectedActions: [],
      observations: [],
      reviseCount: 0,
      requireMoreEvidence: false
    };

    return await runSingleListingAgent(state, steps);
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
    const nextAction = await decideNextAction(state, steps);
    const parsedAction = AgentNextActionSchema.parse(nextAction);

    steps.push(
      step("Autonomous Listing Editor Agent", LISTING_EDITOR_SYSTEM_PROMPT, summarizeState(state), {
        ...parsedAction,
        action_number: iteration + 1,
        llm_mode: state.deterministicPlanner
          ? "deterministic_policy"
          : process.env.LLM_MODE === "live" && process.env.ENABLE_AGENT_DECISION_LLM === "true"
            ? "live_requested"
            : "deterministic_policy"
      })
    );

    state.selectedActions.push(parsedAction.next_action);

    const shouldContinue = await runAction(parsedAction, state, steps);
    if (state.proposal?.action === "stop_without_action" && !state.auditLog) {
      const stopAction = action(
        "stop_without_action",
        { listing_id: state.listingId, runtime_terminal_from: parsedAction.next_action },
        "The latest tool observation produced a stop decision, so no Supervisor approval or page edit is needed.",
        "Stop without page update.",
        true
      );
      steps.push(
        step("Autonomous Listing Editor Agent", LISTING_EDITOR_SYSTEM_PROMPT, summarizeState(state), {
          ...stopAction,
          action_number: iteration + 1,
          llm_mode: "runtime_auto_stop"
        })
      );
      state.selectedActions.push(stopAction.next_action);
      await runAction(stopAction, state, steps);
      break;
    }

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
    review_coverage_state: state.nextReviewCoverageState ?? state.reviewCoverageState ?? null,
    audit_log: state.auditLog ?? null
  };
}

async function executePortfolioAgent(
  prompt: string,
  steps: AgentStep[],
  portfolioPageDescriptions: Record<string, string>,
  reviewCoverageState: ReviewCoverageSnapshot | undefined,
  sessionId: string
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
      sessionId: `${sessionId}:portfolio`,
      currentDescriptionOverride: portfolioPageDescriptions[listing.id],
      reviewCoverageState,
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
    review_coverage_state: reviewCoverageState ?? null,
    audit_log: null
  };
}

async function decideNextAction(state: AgentState, steps: AgentStep[]): Promise<AgentNextAction> {
  const mockResponse = chooseNextAction(state);

  if (state.deterministicPlanner || !shouldUseLlmForDecision(state)) {
    return enforceActionPreconditions(state, mockResponse);
  }

  const result = await callLlmJsonWithTrace<AgentNextAction>({
    module: "Autonomous Listing Editor Agent",
    messages: [
      { role: "system", content: LISTING_EDITOR_SYSTEM_PROMPT },
      { role: "user", content: summarizeState(state) }
    ],
    mockResponse
  });
  if (result.step) {
    steps.push(result.step);
  }

  const parsed = AgentNextActionSchema.safeParse(result.output);
  if (!parsed.success) {
    if (result.calledLive) {
      throw new Error("Autonomous Listing Editor Agent returned JSON that failed runtime validation.");
    }
    state.observations.push("LLM action output failed runtime validation; deterministic policy selected the next action.");
    return enforceActionPreconditions(state, mockResponse);
  }

  return enforceActionPreconditions(state, parsed.data);
}

function shouldUseLlmForDecision(state: AgentState): boolean {
  if (process.env.ENABLE_AGENT_DECISION_LLM !== "true") {
    return false;
  }

  if (process.env.LLM_MODE !== "live") {
    return false;
  }

  if (
    state.stopReason ||
    state.auditLog ||
    state.managerRecommendations ||
    state.evidenceReport ||
    !state.listing ||
    state.supervisor?.decision === "Approve" ||
    state.supervisor?.decision === "Block" ||
    state.supervisor?.decision === "Revise" ||
    state.proposal?.action === "stop_without_action"
  ) {
    return false;
  }

  if (state.listing && !state.claims && !isRestoreRequest(state) && !needsEvidenceReport(state)) {
    return false;
  }

  if (state.listing && isRestoreRequest(state) && !state.proposal) {
    return false;
  }

  if (state.claims && isCopyPolishRequest(state) && !state.proposal) {
    return false;
  }

  if (
    state.reviews &&
    !needsEvidenceReport(state) &&
    needsGooglePlaces(state) &&
    !state.places
  ) {
    return false;
  }

  if (
    state.reviews &&
    !needsEvidenceReport(state) &&
    (!needsGooglePlaces(state) || state.places) &&
    !state.signals
  ) {
    return false;
  }

  if (state.signals && needsManagerRecommendations(state) && !state.managerRecommendations) {
    return false;
  }

  if (state.reviews && needsEvidenceReport(state) && !state.evidenceReport) {
    return false;
  }

  if (state.proposal && !state.supervisor) {
    return false;
  }

  return true;
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

  if (state.claims && isCopyPolishRequest(state) && !state.proposal && proposed.next_action !== "draft_description_polish") {
    return action(
      "draft_description_polish",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "The manager asked for copy polish only, so the agent should rewrite the current description without review retrieval or Google Places.",
      "A copy-polish proposal is missing."
    );
  }

  if (state.listing && needsEvidenceReport(state) && !state.reviews && proposed.next_action !== "search_reviews") {
    return action(
      "search_reviews",
      reviewSearchToolInput(state, { runtime_override_from: proposed.next_action }),
      "The manager asked for more review evidence only, so the agent should retrieve focused guest reviews before producing a report.",
      "Evidence-only request needs review retrieval."
    );
  }

  if (state.claims && !isCopyPolishRequest(state) && !state.reviews && proposed.next_action !== "search_reviews") {
    return action(
      "search_reviews",
      reviewSearchToolInput(state, { runtime_override_from: proposed.next_action }),
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
      { listing_id: state.listingId, radius_km: requestedPlacesRadiusKm(state.prompt), runtime_override_from: proposed.next_action },
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

  if (
    state.listing &&
    isRestoreRequest(state) &&
    !state.proposal &&
    proposed.next_action !== (isRestorePreviousRequest(state) ? "restore_previous_page" : "restore_original_page")
  ) {
    const restoreAction = isRestorePreviousRequest(state) ? "restore_previous_page" : "restore_original_page";
    return action(
      restoreAction,
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      isRestorePreviousRequest(state)
        ? "The manager asked to undo the latest simulated edit, so the legal next action is restoring the previous in-session version."
        : "The manager asked to restore the simulated page to the original dataset text.",
      "A restore proposal is needed."
    );
  }

  if (state.proposal?.action === "stop_without_action" && proposed.next_action !== "stop_without_action") {
    return action(
      "stop_without_action",
      { listing_id: state.listingId, runtime_override_from: proposed.next_action },
      "The tool determined that no useful page change is available, so Supervisor approval is not needed.",
      "Stop without page update.",
      true
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
      const restoreAction = isRestorePreviousRequest(state) ? "restore_previous_page" : "restore_original_page";
      return action(
        restoreAction,
        { listing_id: state.listingId },
        isRestorePreviousRequest(state)
          ? "The manager asked to undo the latest simulated edit, so the agent can restore the previous in-session page version."
          : "The manager asked to restore the simulated page to the original read-only dataset source.",
        "A restore proposal is needed."
      );
    }

    if (!state.supervisor) {
      return action("submit_to_supervisor", { listing_id: state.listingId }, "Even a restore action goes through Supervisor / Control Agent approval.", "Supervisor decision is missing.");
    }

    if (state.supervisor.decision === "Approve" && !state.auditLog) {
      return action("prepare_edit_proposal", { listing_id: state.listingId, execute: true }, "Supervisor approved the controlled restore action.", "Approved restore still needs execution.");
    }

    return action("stop_without_action", {}, "The restore request reached a terminal state.", "Stop execution.", true);
  }

  if (needsEvidenceReport(state)) {
    if (!state.reviews) {
      return action(
        "search_reviews",
        reviewSearchToolInput(state),
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

  if (isCopyPolishRequest(state)) {
    if (!state.proposal) {
      return action(
        "draft_description_polish",
        { listing_id: state.listingId },
        "The manager asked for stronger listing copy without new evidence search, so the agent should polish only the current description text.",
        "A copy-polish replacement proposal is missing."
      );
    }

    if (state.proposal.action === "stop_without_action") {
      return action("stop_without_action", {}, "The copy-polish tool found no useful wording change.", "Stop execution.", true);
    }

    if (!state.supervisor) {
      return action("submit_to_supervisor", { listing_id: state.listingId }, "Copy-polish replacements still require Supervisor / Control Agent approval.", "Supervisor decision is missing.");
    }

    if (state.supervisor.decision === "Approve" && !state.auditLog) {
      return action("prepare_edit_proposal", { listing_id: state.listingId, execute: true }, "Supervisor approved the copy-polish replacement.", "Approved replacement still needs execution.");
    }

    return action("stop_without_action", {}, "The copy-polish request reached a terminal state.", "Stop execution.", true);
  }

  if (!state.reviews) {
    return action("search_reviews", reviewSearchToolInput(state), "Guest reviews are the primary evidence source.", "Review evidence is missing.");
  }

  if (needsGooglePlaces(state) && !state.places) {
    return action("get_google_places", { listing_id: state.listingId, radius_km: requestedPlacesRadiusKm(state.prompt) }, "Location or nearby-context intent requires environmental context.", "Google Places context is missing.");
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

  if (state.supervisor.decision === "Revise" && state.reviseCount < 2) {
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

      state.page = await getSimulatedListingPage(listing, state.currentDescriptionOverride);
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

      const reviewResult = await runAdaptiveReviewSearch(state);
      const reviews = reviewResult.reviews;
      const relevantReviews = searchRelevantReviews(reviews, state.intent, Math.min(reviews.length, 24));
      const indexedReviewTextCount = await getReviewTextCountForListing(state.listing.id);
      state.reviews = reviews;
      state.reviewSource = reviewResult.source;
      state.indexedReviewTextCount = indexedReviewTextCount;
      state.reviewSearchStats = reviewResult.stats;
      state.relevantReviews = relevantReviews;
      steps.push(step("Review RAG", "Retrieve Airbnb guest reviews for the selected listing.", JSON.stringify(actionRequest.tool_input), {
        listing_id: state.listing.id,
        source: reviewResult.source,
        indexed_review_texts_available: indexedReviewTextCount,
        retrieved_review_count: reviews.length,
        relevant_review_count: relevantReviews.length,
        search_strategy: reviewResult.stats.strategy,
        queries_run: reviewResult.stats.queriesRun,
        query_topics: reviewResult.stats.queryTopics,
        top_k_per_query: reviewResult.stats.topKPerQuery,
        target_unique_reviews: reviewResult.stats.targetUniqueReviews,
        max_unique_reviews: reviewResult.stats.maxUniqueReviews,
        coverage_window_size: reviewResult.stats.coverageWindowSize,
        coverage_scope_key: reviewResult.stats.coverageScopeKey,
        coverage_total_reviews_in_scope: reviewResult.stats.coverageTotalReviewsInScope,
        coverage_previously_covered_count: reviewResult.stats.coveragePreviouslyCoveredCount,
        coverage_new_reviews_count: reviewResult.stats.coverageNewReviewsCount,
        coverage_covered_after_count: reviewResult.stats.coverageCoveredAfterCount,
        coverage_complete: reviewResult.stats.coverageComplete,
        time_budget_ms: reviewResult.stats.timeBudgetMs,
        elapsed_ms: reviewResult.stats.elapsedMs,
        stop_reason: reviewResult.stats.stopReason,
        total_reviews_available: indexedReviewTextCount,
        retrieved_reviews: relevantReviews.map((review) => ({
          review_id: review.id,
          listing_id: review.listingId,
          date: review.date,
          excerpt: excerpt(review.comments)
        })),
        retrieval_note:
          reviewResult.source === "pinecone"
            ? "Pinecone searched the full review namespace with adaptive topic queries filtered by listing_id, then the agent merged unique review evidence within the run budget."
            : "The local CSV fallback filtered all prepared review texts by listing_id, then returned a bounded relevant sample for the current action.",
        coverage_note:
          "The agent also adds a new unseen local review window for this listing and audit scope during the current demo session, so repeated requests continue reviewing additional source reviews instead of reusing only the same sample."
      }));
      return true;
    }

    case "get_google_places": {
      if (!state.listing) {
        throw new Error("Cannot retrieve places before listing data is loaded.");
      }

      const radiusKm = requestedPlacesRadiusKm(state.prompt);
      const places = await getPlacesNearListing(state.listing, 40, radiusKm);
      const relevantPlaces = filterRelevantPlaces(places, state.intent);
      state.places = places;
      state.relevantPlaces = relevantPlaces;
      steps.push(step("Google Places Context", "Retrieve nearby Google Places context when relevant.", JSON.stringify(actionRequest.tool_input), {
        listing_id: state.listing.id,
        requested_radius_km: radiusKm,
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
        const restoreAction = isRestorePreviousRequest(state) ? "restore_previous_page" : "restore_original_page";
        const proposal = EditProposalSchema.parse({
          action: restoreAction,
          target_fields: ["description"],
          listing_id: state.listing.id,
          proposed_description_addition: null,
          proposed_description_replacement: null,
          evidence_topics: [isRestorePreviousRequest(state) ? "Restore previous simulated version" : "Restore original dataset state"],
          reason: isRestorePreviousRequest(state)
            ? "The manager rejected the latest simulated edit and asked to return the listing page to the previous version text."
            : "The manager rejected the simulated edit and asked to return the listing page to its original dataset text."
        });
        state.proposal = proposal;
        steps.push(step("Edit & Decision Tools", "Draft a controlled restore action for the simulated listing page.", JSON.stringify(actionRequest.tool_input), {
          proposed_action: proposal,
          restore_source: isRestorePreviousRequest(state) ? "Previous in-session simulated page version" : "Original Airbnb listing row from the prepared dataset",
          editable_scope: "Simulated page description only"
        }));
        return true;
      }

      if (!state.signals) {
        throw new Error("Cannot draft an edit before signals are detected.");
      }

      const proposal = EditProposalSchema.parse(
        draftEdit(
          state.listing,
          state.signals,
          state.page?.currentDescription ?? state.listing.description,
          state.reviewSearchStats,
          state.intent,
          state.rejectedTopics ?? []
        )
      );
      state.proposal = proposal;
      steps.push(step("Edit & Decision Tools", "Draft a narrow page edit, ask for more evidence, or stop.", JSON.stringify(actionRequest.tool_input), {
        proposed_action: proposal,
        evidence_validation: validateEvidence(state)
      }));
      return true;
    }

    case "draft_description_polish": {
      if (!state.listing || !state.page) {
        throw new Error("Cannot polish description before listing data is loaded.");
      }

      const proposal = EditProposalSchema.parse(draftDescriptionPolish(state.listing, state.page.currentDescription));
      state.proposal = proposal;
      steps.push(step("Edit & Decision Tools", "Draft a copy-polish replacement for the current simulated description.", JSON.stringify(actionRequest.tool_input), {
        proposed_action: proposal,
        edit_mode: "copy_polish_only",
        retrieval_used: false,
        google_places_used: false,
        editable_scope: "Description wording only; existing facts, names, ratings, distances, and review counts must be preserved."
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
        proposed_description_replacement: null,
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

    case "restore_previous_page": {
      if (!state.listing) {
        throw new Error("Cannot restore the page before listing data is loaded.");
      }

      const proposal = EditProposalSchema.parse({
        action: "restore_previous_page",
        target_fields: ["description"],
        listing_id: state.listing.id,
        proposed_description_addition: null,
        proposed_description_replacement: null,
        evidence_topics: ["Restore previous simulated version"],
        reason: state.previousDescriptionOverride || state.page?.previousDescription
          ? "The manager rejected the latest simulated edit and asked to return the listing page to the previous version text."
          : "No previous simulated page version is available in the current demo session."
      });
      state.proposal = proposal;
      steps.push(step("Edit & Decision Tools", "Restore the simulated listing page to the previous in-session version.", JSON.stringify(actionRequest.tool_input), {
        proposed_action: proposal,
        restore_source: "Previous in-session simulated page version",
        previous_version_available: Boolean(state.previousDescriptionOverride || state.page?.previousDescription),
        editable_scope: "Simulated page description only"
      }));
      return true;
    }

    case "submit_to_supervisor": {
      if (!state.proposal || (!state.signals && !proposalCanSkipReviewSignals(state.proposal))) {
        throw new Error("Cannot submit to Supervisor before an edit proposal exists.");
      }

      const guardrails = validateProposal(state.proposal, state);
      const signals = state.signals ?? [];
      const fallbackSupervisor = supervise(state.proposal, signals, guardrails.passed);
      const supervisorResult = await callLlmJsonWithTrace<SupervisorOutput>({
        module: "Supervisor / Control Agent",
        messages: [
          { role: "system", content: SUPERVISOR_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ proposal: state.proposal, signals, guardrails }) }
        ],
        mockResponse: fallbackSupervisor
      });

      const normalizedSupervisor = normalizeSupervisorOutput(supervisorResult.output);
      const parsedSupervisor = SupervisorOutputSchema.safeParse(normalizedSupervisor);
      const llmOutputValid = parsedSupervisor.success;
      const safeSupervisor = parsedSupervisor.success
        ? parsedSupervisor.data
        : {
            ...fallbackSupervisor,
            rationale: `${fallbackSupervisor.rationale} LLM Supervisor output failed runtime validation, so deterministic Supervisor policy was used.`
          };
      state.supervisor = SupervisorOutputSchema.parse(enforceGuardrails(state.proposal, safeSupervisor, state));
      steps.push({
        module: "Supervisor / Control Agent",
        prompt: supervisorResult.step?.prompt ?? {
          system_prompt: SUPERVISOR_SYSTEM_PROMPT,
          user_prompt: JSON.stringify({ proposal: state.proposal, signals, guardrails })
        },
        response: {
          ...state.supervisor,
          guardrails: {
            ...guardrails,
            llm_output_valid: llmOutputValid,
            live_llm_called: supervisorResult.calledLive
          }
        }
      });
      return true;
    }

    case "replan": {
      state.reviseCount += 1;
      state.requireMoreEvidence = true;
      state.rejectedTopics = [
        ...(state.rejectedTopics ?? []),
        ...topicsRejectedBySupervisor(state.proposal, state.supervisor)
      ].filter((topic, index, topics) => topics.indexOf(topic) === index);
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

      state.pageUpdate = await applySimulatedPageUpdate(
        state.listing,
        state.proposal,
        state.supervisor.decision,
        state.previousDescriptionOverride
      );
      if (state.proposal.action === "restore_original_page") {
        resetReviewCoverageForListing(state.sessionId, state.listing.id);
      }
      state.auditLog = await createAuditLog({
        listing: state.listing,
        managerPrompt: state.prompt,
        decision: state.supervisor.decision,
        selectedActions: state.selectedActions,
        evidenceSummary: auditEvidenceSummary(state),
        proposal: state.proposal,
        pageUpdate: state.pageUpdate,
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
        state.pageUpdate = await applySimulatedPageUpdate(state.listing, state.proposal ?? stopProposal(state.listing.id), decision);
        state.auditLog = await createAuditLog({
          listing: state.listing,
          managerPrompt: state.prompt,
          decision,
          selectedActions: state.selectedActions,
          evidenceSummary: auditEvidenceSummary(state),
          proposal: state.proposal ?? stopProposal(state.listing.id),
          pageUpdate: state.pageUpdate,
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
    .filter(([, keywords]) => keywords.some((keyword) => promptHasKeyword(normalized, keyword)))
    .map(([topic]) => topic);

  if (isEvidenceOnlyPrompt(prompt)) {
    return Array.from(
      new Set([
        "evidence_search",
        ...topics.filter((topic) => !["review_alignment", "nearby_highlights", "restore_original"].includes(topic))
      ])
    );
  }

  if (isNearbyOnlyPrompt(prompt)) {
    return Array.from(
      new Set([
        "nearby_highlights",
        "location",
        ...topics.filter((topic) => !["review_alignment", "evidence_search", "restore_original", "copy_polish"].includes(topic))
      ])
    );
  }

  const reviewOnly = isReviewOnlyPrompt(prompt);
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
        ...(reviewOnly ? ["review_only"] : ["nearby_highlights"]),
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
    /\b(return|give|list|show)\b.{0,40}\b(review\s+)?examples?\b.{0,60}\b(do not edit|without editing|no page edit|only)\b/i.test(prompt) ||
    /\b(more\s+)?(evidence|evidance|avidance|proof|examples?)\s+(for|about|of|to)\b/i.test(prompt) ||
    /עוד\s+(עדויות|ראיות|דוגמאות)|תמצא\s+עוד|הוכחות/i.test(prompt);
}

function promptHasKeyword(normalizedPrompt: string, keyword: string): boolean {
  const normalizedKeyword = keyword.toLowerCase();
  if (/^[a-z0-9-]+$/.test(normalizedKeyword) && normalizedKeyword.length <= 5) {
    return new RegExp(`\\b${escapeRegex(normalizedKeyword)}\\b`, "i").test(normalizedPrompt);
  }

  return normalizedPrompt.includes(normalizedKeyword);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isReviewOnlyPrompt(prompt: string): boolean {
  return /\b(guest\s+reviews|reviews)\s+only\b/i.test(prompt) ||
    /\bonly\s+(?:the\s+)?(?:guest\s+)?reviews\b/i.test(prompt) ||
    /\b(without google places|do not use google places|no nearby context)\b/i.test(prompt) ||
    /\bfocus only on gaps between\b.{0,80}\bguest reviews\b/i.test(prompt);
}

function isNearbyOnlyPrompt(prompt: string): boolean {
  return /\b(focus only on nearby|nearby guest value|nearby value|places around|surrounding places)\b/i.test(prompt) ||
    /\bwithin\s+(?:about\s+)?\d+(?:\.\d+)?\s*(?:km|kilometers?)\b/i.test(prompt);
}

function reviewQueryForIntent(listing: Listing, intent: string[]): string {
  const topics = intent
    .filter((topic) => !["review_alignment", "restore_original", "evidence_search", "review_only"].includes(topic))
    .slice(0, 8)
    .join(", ");

  return [
    `Lisbon Airbnb guest reviews for listing ${listing.id}: ${listing.name}.`,
    topics ? `Find review evidence about ${topics}.` : "Find repeated guest experience signals.",
    "Prefer concrete guest experience details over generic praise."
  ].join(" ");
}

function needsGooglePlaces(state: AgentState): boolean {
  if (needsManagerRecommendations(state) || state.intent.includes("review_only")) {
    return false;
  }

  return (
    state.intent.includes("location") ||
    state.intent.includes("noise") ||
    state.intent.includes("nearby_highlights") ||
    state.intent.includes("hills")
  );
}

function requestedPlacesRadiusKm(prompt: string): number {
  const match = prompt.match(/\b(?:within|inside|radius|under|up to|עד|רדיוס)\s*(?:about|around|בערך)?\s*(\d+(?:\.\d+)?)\s*(?:km|kilometers?|קמ|ק״מ)\b/i) ||
    prompt.match(/\b(\d+(?:\.\d+)?)\s*(?:km|kilometers?|קמ|ק״מ)\b/i);
  const parsed = match?.[1] ? Number(match[1]) : 2;
  if (!Number.isFinite(parsed)) {
    return 2;
  }

  return Math.min(Math.max(parsed, 0.2), 2);
}

function needsManagerRecommendations(state: AgentState): boolean {
  return state.intent.includes("property_fixes");
}

function needsEvidenceReport(state: AgentState): boolean {
  return state.intent.includes("evidence_search");
}

function reviewSearchToolInput(state: AgentState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const plan = reviewSearchPlan(state);
  return {
    listing_id: state.listingId,
    topics: state.intent,
    search_mode: plan.strategy,
    time_budget_ms: plan.timeBudgetMs,
    target_unique_reviews: plan.targetUniqueReviews,
    max_unique_reviews: plan.maxUniqueReviews,
    coverage_window_size: plan.coverageWindowSize,
    coverage_scope_key: reviewCoverageScopeKey(state),
    ...extra
  };
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

async function runAdaptiveReviewSearch(
  state: AgentState
): Promise<{ reviews: Review[]; source: "pinecone" | "csv_fallback"; stats: ReviewSearchStats }> {
  if (!state.listing) {
    throw new Error("Cannot run adaptive review search before listing data is loaded.");
  }

  const plan = reviewSearchPlan(state);
  const start = Date.now();
  const semanticByKey = new Map<string, Review>();
  let source: "pinecone" | "csv_fallback" = "pinecone";
  let queriesRun = 0;
  let semanticStopReason = "completed_all_planned_queries";
  const semanticCap = Math.max(0, plan.maxUniqueReviews - plan.coverageWindowSize);

  for (const focus of plan.focuses) {
    if (Date.now() - start >= plan.timeBudgetMs) {
      semanticStopReason = "time_budget_reached";
      break;
    }

    queriesRun += 1;
    const result = await getReviewSearchResult(state.listing.id, focus.query, plan.topKPerQuery);
    source = result.source;

    for (const review of result.reviews) {
      semanticByKey.set(review.id || `${review.listingId}:${review.comments.slice(0, 80)}`, review);
      if (semanticCap > 0 && semanticByKey.size >= semanticCap) {
        break;
      }
    }

    if (source === "csv_fallback") {
      semanticStopReason = "csv_fallback_single_pass";
      break;
    }

    if (semanticByKey.size >= plan.targetUniqueReviews) {
      semanticStopReason = "target_unique_reviews_reached";
      break;
    }

    if (semanticCap > 0 && semanticByKey.size >= semanticCap) {
      semanticStopReason = "semantic_review_cap_reached";
      break;
    }
  }

  const localReviews = await getLocalReviewsForListing(state.listing.id);
  const scopeKey = reviewCoverageScopeKey(state);
  const scopedReviews = scopeReviewsForIntent(localReviews, state.intent, state.prompt);
  const coverage = selectNextReviewCoverageWindow({
    sessionId: state.sessionId,
    listingId: state.listing.id,
    scopeKey,
    reviews: scopedReviews.length > 0 ? scopedReviews : localReviews,
    windowSize: plan.coverageWindowSize,
    snapshot: state.nextReviewCoverageState ?? state.reviewCoverageState
  });
  state.nextReviewCoverageState = coverage.snapshot;

  const mergedByKey = new Map<string, Review>();
  for (const review of coverage.reviews) {
    mergedByKey.set(review.id || `${review.listingId}:${review.comments.slice(0, 80)}`, review);
  }

  for (const review of semanticByKey.values()) {
    if (mergedByKey.size >= plan.maxUniqueReviews) {
      break;
    }
    mergedByKey.set(review.id || `${review.listingId}:${review.comments.slice(0, 80)}`, review);
  }

  const reviews = [...mergedByKey.values()].slice(0, plan.maxUniqueReviews);
  const stopReason = [
    semanticStopReason,
    coverage.completed ? "review_coverage_scope_complete" : "review_coverage_window_selected"
  ].join("; ");

  return {
    reviews,
    source,
    stats: {
      strategy: plan.strategy,
      queriesRun,
      queryTopics: plan.focuses.slice(0, queriesRun).map((focus) => focus.label),
      topKPerQuery: plan.topKPerQuery,
      targetUniqueReviews: plan.targetUniqueReviews,
      maxUniqueReviews: plan.maxUniqueReviews,
      coverageWindowSize: plan.coverageWindowSize,
      coverageScopeKey: coverage.scopeKey,
      coverageTotalReviewsInScope: coverage.totalReviewsInScope,
      coveragePreviouslyCoveredCount: coverage.previouslyCoveredCount,
      coverageNewReviewsCount: coverage.newlyCoveredCount,
      coverageCoveredAfterCount: coverage.coveredAfterCount,
      coverageComplete: coverage.completed,
      timeBudgetMs: plan.timeBudgetMs,
      elapsedMs: Date.now() - start,
      stopReason
    }
  };
}

type ReviewSearchPlan = {
  strategy: string;
  focuses: Array<{ label: string; query: string }>;
  topKPerQuery: number;
  targetUniqueReviews: number;
  maxUniqueReviews: number;
  coverageWindowSize: number;
  timeBudgetMs: number;
};

function reviewSearchPlan(state: AgentState): ReviewSearchPlan {
  const listing = state.listing;
  const name = listing?.name ?? "the selected listing";
  const id = state.listingId;
  const base = `Lisbon Airbnb guest reviews for listing ${id}: ${name}.`;
  const timeBudgetMs = Number(process.env.REVIEW_RAG_TIME_BUDGET_MS ?? 90000);
  const focus = (label: string, query: string) => ({
    label,
    query: `${base} ${query} Prefer concrete guest experience details over generic praise.`
  });

  if (needsEvidenceReport(state)) {
    const topic = evidenceReportTopic(state.intent, state.prompt);
    const topicKeywords = evidenceSearchQueryText(state.intent, state.prompt);
    return {
      strategy: "adaptive_time_boxed_evidence_report",
      focuses: [
        focus(topic, `Find direct review examples about ${topicKeywords}.`),
        focus(`${topic} complaints`, `Find negative or mixed guest comments about ${topicKeywords}.`),
        focus(`${topic} practical impact`, `Find reviews that mention how ${topicKeywords} affected work, comfort, check-in, or stay quality.`)
      ],
      topKPerQuery: 50,
      targetUniqueReviews: 100,
      maxUniqueReviews: 260,
      coverageWindowSize: 180,
      timeBudgetMs
    };
  }

  if (needsManagerRecommendations(state)) {
    return {
      strategy: "adaptive_time_boxed_manager_insights",
      focuses: [
        focus("fixable operational issues", "Find repeated fixable complaints about Wi-Fi, noise, temperature, access, cleanliness, sleep comfort, check-in, or space."),
        focus("guest friction", "Find concrete guest friction, maintenance issues, missing basics, or avoidable operational problems."),
        focus("review quality opportunities", "Find issues that could affect ratings, booking confidence, or guest satisfaction.")
      ],
      topKPerQuery: 50,
      targetUniqueReviews: 110,
      maxUniqueReviews: 280,
      coverageWindowSize: 200,
      timeBudgetMs
    };
  }

  if (state.intent.includes("nearby_highlights") && !state.intent.includes("review_alignment")) {
    return {
      strategy: "adaptive_time_boxed_nearby_support",
      focuses: [
        focus("nearby value", "Find reviews about walkable location, nearby restaurants, cafes, parks, attractions, transit, and useful local options."),
        focus("location selling points", "Find guest comments that explain why the surrounding Lisbon area improves the stay.")
      ],
      topKPerQuery: 50,
      targetUniqueReviews: 90,
      maxUniqueReviews: 220,
      coverageWindowSize: 160,
      timeBudgetMs
    };
  }

  if (state.intent.includes("review_alignment")) {
    return {
      strategy: "adaptive_time_boxed_end_to_end_alignment",
      focuses: [
        focus("repeated guest experience signals", "Find repeated guest experience signals across location, noise, access, temperature, comfort, cleanliness, Wi-Fi, view, and space."),
        focus("expectation mismatches", "Find comments that show mismatch between listing expectations and guest reality, especially noise, stairs, hills, heat, room size, Wi-Fi, or comfort."),
        focus("guest-confirmed strengths", "Find repeated positive strengths that should improve listing copy: location, walkability, cleanliness, view, comfort, and convenience."),
        focus("nearby and location support", "Find review support for nearby restaurants, attractions, cafes, transit, parks, and walkable Lisbon context.")
      ],
      topKPerQuery: 60,
      targetUniqueReviews: 150,
      maxUniqueReviews: 360,
      coverageWindowSize: 240,
      timeBudgetMs
    };
  }

  return {
    strategy: "adaptive_time_boxed_focused_review_search",
    focuses: [
      focus("focused topic search", `Find review evidence about ${state.intent.join(", ") || "the requested topic"}.`),
      focus("supporting examples", "Find concrete examples for the requested guest-review topic.")
    ],
    topKPerQuery: 32,
    targetUniqueReviews: 64,
    maxUniqueReviews: 180,
    coverageWindowSize: 140,
    timeBudgetMs
  };
}

function reviewCoverageScopeKey(state: AgentState): string {
  const mode = needsEvidenceReport(state)
    ? "evidence"
    : needsManagerRecommendations(state)
      ? "manager"
      : state.intent.includes("nearby_highlights") && !state.intent.includes("review_alignment")
        ? "nearby"
        : state.intent.includes("review_alignment")
          ? "alignment"
          : "focused";

  if (mode === "alignment") {
    const contextMode = state.intent.includes("nearby_highlights") ? "reviews_and_nearby" : "reviews_only";
    return `alignment:${contextMode}`;
  }

  if (mode === "manager") {
    return "manager:fixable_property_and_operations_issues";
  }

  const topics = state.intent
    .filter((topic) => !["restore_original", "review_only"].includes(topic))
    .filter((topic) => topic !== "review_alignment")
    .sort();

  const radius = mode === "nearby" ? `:radius_${requestedPlacesRadiusKm(state.prompt)}` : "";
  return `${mode}:${topics.join("+") || "all"}${radius}`;
}

function scopeReviewsForIntent(reviews: Review[], intent: string[], prompt: string): Review[] {
  if (intent.includes("review_alignment") || intent.includes("property_fixes")) {
    return reviews;
  }

  const keywords = scopeKeywordsForIntent(intent, prompt);
  if (keywords.length === 0) {
    return reviews;
  }

  return reviews.filter((review) => {
    const normalized = review.comments.toLowerCase();
    return keywords.some((keyword) => promptHasKeyword(normalized, keyword));
  });
}

function scopeKeywordsForIntent(intent: string[], prompt: string): string[] {
  if (intent.includes("nearby_highlights")) {
    return [
      ...(topicKeywords.location ?? []),
      ...(topicKeywords.nearby_highlights ?? []),
      "restaurant",
      "restaurants",
      "cafe",
      "cafes",
      "park",
      "attraction",
      "transit",
      "transport"
    ];
  }

  if (intent.includes("evidence_search")) {
    return intent
      .filter((topic) => topicKeywords[topic])
      .flatMap((topic) => topicKeywords[topic]);
  }

  return intent
    .filter((topic) => !["review_alignment", "restore_original", "review_only"].includes(topic))
    .filter((topic) => topicKeywords[topic])
    .flatMap((topic) => topicKeywords[topic]);
}

function evidenceSearchQueryText(intent: string[], prompt: string): string {
  if (intent.includes("wifi") || /wi-?fi|internet|connection|remote.?work/i.test(prompt)) {
    return "Wi-Fi reliability, internet connection, router, and remote-work experience";
  }
  if (intent.includes("noise")) return "noise, loud street activity, bars, nightlife, and sleep disturbance";
  if (intent.includes("temperature")) return "temperature comfort, heat, cold, heating, air conditioning, and ventilation";
  if (intent.includes("stairs")) return "stairs, steps, elevator, lift, luggage access, and arrival access";
  if (intent.includes("hills")) return "steep streets, hills, walking effort, and luggage movement";
  if (intent.includes("space")) return "small room, compact space, cramped feeling, and storage";
  if (intent.includes("cleanliness")) return "cleanliness, dust, smell, tidy condition, and cleaning consistency";
  if (intent.includes("comfort")) return "bed comfort, mattress, pillows, sleep quality, and general comfort";
  if (intent.includes("location")) return "location, walkability, transit, restaurants, nearby sights, and convenience";
  return "the requested guest-review issue";
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
  const notUsefulForListingCopy =
    /storage|luggage|facility|atm|bank|real estate|school|clinic|pharmacy|parking|apartment|apartments|vacation rental|vacation rentals|rental office|booking\.com|airbnb/i.test(
      text
    );
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
  const reviews = place.numberOfReviews > 0 ? `, ${place.numberOfReviews} Google review texts in the dataset` : "";
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

  if (intent.includes("hills") || (hasBroadIntent && (reviewText.includes("hill") || reviewText.includes("steep")))) {
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

  if (intent.includes("stairs") || (hasBroadIntent && (reviewText.includes("stairs") || reviewText.includes("steps")))) {
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

  if (intent.includes("noise") || (hasBroadIntent && /\b(noise|noisy|loud|nightlife|bar|bars)\b/i.test(reviewText))) {
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

  if (intent.includes("temperature") || (hasBroadIntent && /\b(hot|warm|cold|heating|heater)\b|air conditioning|a\/c/i.test(reviewText))) {
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

  if (intent.includes("space") || (hasBroadIntent && /small|tiny|compact|cramped/i.test(reviewText))) {
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

  if (intent.includes("view") || (hasBroadIntent && /view|views|river|terrace|balcony/i.test(reviewText))) {
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

  if (intent.includes("cleanliness") || (hasBroadIntent && /clean|spotless/i.test(reviewText))) {
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

  if (intent.includes("comfort") || (hasBroadIntent && /comfortable|comfy|bed/i.test(reviewText))) {
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

  if (intent.includes("wifi") || (hasBroadIntent && (reviewText.includes("wifi") || reviewText.includes("internet")))) {
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

  return signals.map(limitSignalEvidence);
}

function limitSignalEvidence(signal: Signal): Signal {
  return {
    ...signal,
    evidence: signal.evidence.slice(0, 8)
  };
}

function topicsRejectedBySupervisor(
  proposal: EditProposal | undefined,
  supervisor: SupervisorOutput | undefined
): string[] {
  if (!proposal || !supervisor || supervisor.decision !== "Revise") {
    return [];
  }

  const supervisorText = `${supervisor.rationale} ${supervisor.required_change ?? ""}`.toLowerCase();
  const proposalText = [
    proposal.proposed_description_addition,
    proposal.proposed_description_replacement
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  const rejected: string[] = [];

  if (
    proposal.evidence_topics?.includes("Remote-work readiness") &&
    /remote|wi-?fi|internet|work setup|overreach|overstat|unsupported/.test(supervisorText)
  ) {
    rejected.push("Remote-work readiness");
  }

  if (
    /google places|nearby|specific venues|ratings?|review counts?|distances?|marketing.?like/.test(supervisorText) ||
    /google places context|google reviews|google review texts/.test(proposalText)
  ) {
    rejected.push("Rated nearby guest options", "Rated nearby dining options");
  }

  if (/street activity|lively center|noise|noisy/.test(supervisorText) || /street activity may be part|lively center/.test(proposalText)) {
    rejected.push("Noise expectations");
  }

  if (
    /comfortable walking shoes|nearby streets are steep|historic lisbon hills/.test(supervisorText) ||
    /comfortable walking shoes|nearby streets are steep/.test(proposalText)
  ) {
    rejected.push("Historic Lisbon hills");
  }

  if (
    proposal.evidence_topics?.includes("Temperature expectations") &&
    /temperature|cooling|fan|cooler|warmer lisbon|broader claim/.test(supervisorText)
  ) {
    rejected.push("Temperature expectations");
  }

  return rejected;
}

function isSafePageEditSignal(listing: Listing, signal: Signal, intent: string[]): boolean {
  if (signal.topic !== "Remote-work readiness") {
    return true;
  }

  const explicitConnectivityRequest = intent.includes("wifi");
  const hasWifiAmenity = listing.amenities.some((amenity) => amenity.toLowerCase().includes("wifi"));
  const evidenceText = signal.evidence.join(" ").toLowerCase();
  const hasNegativeConnectivityEvidence =
    /hit or miss|bad|poor|weak|slow|problem|issue|didn.?t work|doesn.?t work|not work|unreliable|spotty|unstable|no wi-?fi|without wi-?fi/.test(
      evidenceText
    );
  const positiveConnectivityEvidence = signal.evidence.filter(
    (item) =>
      /wi-?fi|internet|connection/i.test(item) &&
      /good|great|strong|fast|reliable|worked well|excellent/i.test(item)
  ).length;

  return explicitConnectivityRequest && hasWifiAmenity && !hasNegativeConnectivityEvidence && positiveConnectivityEvidence >= 3;
}

function draftEdit(
  listing: Listing,
  signals: Signal[],
  currentDescription: string,
  reviewStats?: ReviewSearchStats,
  intent: string[] = [],
  rejectedTopics: string[] = []
): EditProposal {
  const nearbyPlacesOnly = intent.includes("nearby_highlights") && !intent.includes("review_alignment");
  const candidateSignals = nearbyPlacesOnly
    ? signals.filter((signal) => /^Rated nearby/i.test(signal.topic))
    : signals;
  const editableSignals = candidateSignals
    .filter(
      (signal) =>
        signal.type !== "insufficient_evidence" &&
        signal.primaryEvidenceCount >= 2 &&
        !rejectedTopics.includes(signal.topic) &&
        isSafePageEditSignal(listing, signal, intent) &&
        !descriptionAlreadyCoversSignal(currentDescription, signal.topic)
    )
    .sort((a, b) => signalPriority(a) - signalPriority(b));

  if (editableSignals.length === 0) {
    const coveredStrongSignals = signals.filter(
      (signal) =>
        signal.type !== "insufficient_evidence" &&
        signal.primaryEvidenceCount >= 2 &&
        descriptionAlreadyCoversSignal(currentDescription, signal.topic)
    );
    if (nearbyPlacesOnly) {
      return stopProposal(
        listing.id,
        `${coverageProgressSentence(reviewStats)}No strong Google Places highlight was found for the requested nearby radius, or the current description already includes the strongest nearby-place text.${coverageContinuationSentence(reviewStats)}`
      );
    }
    const weakEditableSignals = signals.filter(
      (signal) =>
        signal.type !== "insufficient_evidence" &&
        signal.primaryEvidenceCount > 0 &&
        !descriptionAlreadyCoversSignal(currentDescription, signal.topic)
    );
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

    if (coveredStrongSignals.length > 0) {
      return stopProposal(
        listing.id,
        `${coverageProgressSentence(reviewStats)}The current simulated description already covers the strongest supported topics in this review window: ${coveredStrongSignals
          .slice(0, 4)
          .map((signal) => signal.topic)
          .join(", ")}.${coverageContinuationSentence(reviewStats)}`
      );
    }

    return stopProposal(
      listing.id,
      `${coverageProgressSentence(reviewStats)}No strong, editable gap was found in this review window.${coverageContinuationSentence(reviewStats)}`
    );
  }

  const selectedSignals = selectSignalsForEdit(editableSignals);
  if (nearbyPlacesOnly) {
    const places = uniqueFormattedGooglePlaces(selectedSignals.flatMap((signal) => signal.evidence)).slice(0, 4);
    if (places.length > 0) {
      return {
        action: "prepare_edit_proposal",
        target_fields: ["description"],
        listing_id: listing.id,
        proposed_description_addition: `Nearby highlights include ${places.join(", ")}, giving guests strong nearby options within the requested area.`,
        proposed_description_replacement: null,
        evidence_topics: selectedSignals.map((signal) => signal.topic)
      };
    }
  }

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
      return "Some guests mention cooling or fan expectations, so guests who prefer a cooler room may want to check the setup before booking.";
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
      return "Guests often describe the stay as comfortable, which adds useful reassurance for travelers using the property as a central Lisbon base.";
    }
    if (signal.topic === "Remote-work readiness") {
      return "Wi-Fi is listed as an amenity, and guest feedback supports mentioning connectivity only in cautious, factual terms for travelers who may need it.";
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

  const proposedAddition = additions.join(" ");
  const revisedDescription = reviseDescriptionForEvidenceBackedGaps(
    currentDescription,
    selectedSignals,
    proposedAddition,
    rejectedTopics
  );
  if (revisedDescription && normalizeTextForCoverage(revisedDescription) !== normalizeTextForCoverage(currentDescription)) {
    return {
      action: "replace_description",
      target_fields: ["description"],
      listing_id: listing.id,
      proposed_description_addition: null,
      proposed_description_replacement: revisedDescription,
      evidence_topics: selectedSignals.map((signal) => signal.topic),
      reason: "The agent found an evidence-backed wording gap, so it replaced the current simulated description with a safer, more natural version instead of only appending text."
    };
  }

  return {
    action: "prepare_edit_proposal",
    target_fields: ["description"],
    listing_id: listing.id,
    proposed_description_addition: proposedAddition,
    proposed_description_replacement: null,
    evidence_topics: selectedSignals.map((signal) => signal.topic)
  };
}

function draftDescriptionPolish(listing: Listing, currentDescription: string): EditProposal {
  const polished = polishDescriptionCopy(currentDescription);

  if (normalizeTextForCoverage(polished) === normalizeTextForCoverage(currentDescription)) {
    return stopProposal(
      listing.id,
      "The current simulated description is already clean enough for a copy-only polish without changing facts."
    );
  }

  return {
    action: "replace_description",
    target_fields: ["description"],
    listing_id: listing.id,
    proposed_description_addition: null,
    proposed_description_replacement: polished,
    evidence_topics: ["Copy polish only"],
    reason:
      "The manager asked for wording polish only. The agent rewrote the current description to read more naturally while preserving existing facts, names, ratings, distances, and review counts."
  };
}

function reviseDescriptionForEvidenceBackedGaps(
  currentDescription: string,
  signals: Signal[],
  proposedAddition: string,
  rejectedTopics: string[] = []
): string | null {
  if (!signals.some((signal) => signal.type === "accuracy_gap") && rejectedTopics.length === 0) {
    return null;
  }

  const selectedTopics = signals.map((signal) => signal.topic);
  const staleTopics = staleGeneratedTopicsForReplacement(selectedTopics);
  let revised = removeRejectedTopicText(currentDescription, [...rejectedTopics, ...staleTopics]);
  if (signals.some((signal) => signal.topic === "Noise expectations")) {
    revised = revised
      .replace(/\bvery calm area\b/gi, "central Lisbon area")
      .replace(/\bcalm area\b/gi, "central Lisbon area")
      .replace(/\bquiet area\b/gi, "central Lisbon area")
      .replace(/\bvery quiet\b/gi, "central")
      .replace(/\bquiet\b/gi, "central");
  }

  revised = polishDescriptionCopy(revised);
  revised = appendTextIfMissing(revised, proposedAddition);
  return revised;
}

function removeRejectedTopicText(description: string, rejectedTopics: string[]): string {
  if (rejectedTopics.length === 0) {
    return description;
  }

  const rejectNearby =
    rejectedTopics.includes("Rated nearby guest options") ||
    rejectedTopics.includes("Rated nearby dining options");
  const rejectRemoteWork = rejectedTopics.includes("Remote-work readiness");
  const rejectNoise = rejectedTopics.includes("Noise expectations");
  const rejectHills = rejectedTopics.includes("Historic Lisbon hills");
  const rejectTemperature = rejectedTopics.includes("Temperature expectations");

  let cleaned = description;

  if (rejectNearby) {
    cleaned = cleaned
      .replace(/\s*Guest location reviews support highlighting[\s\S]*?(?=\n\n|$)/gi, "")
      .replace(/\s*Guests mention the convenience of nearby places to eat[\s\S]*?(?=\n\n|$)/gi, "")
      .replace(/\s*Nearby highlights include[\s\S]*?(?=\n\n|$)/gi, "");
  }

  if (rejectRemoteWork) {
    cleaned = cleaned
      .replace(/\s*For guests mixing travel with work[\s\S]*?(?=\n\n|$)/gi, "")
      .replace(/\s*Wi-?Fi is listed as an amenity[\s\S]*?(?=\n\n|$)/gi, "");
  }

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((paragraph) => sentenceSplit(paragraph).filter((sentence) => {
      const normalized = normalizeTextForCoverage(sentence);

      if (
        rejectNearby &&
        includesAnyNormalized(normalized, [
          "google places context",
          "google reviews",
          "google review texts",
          "highly rated nearby",
          "nearby dining options",
          "nearby options such as",
          "nearby highlights include",
          "specific venues"
        ])
      ) {
        return false;
      }

      if (
        rejectRemoteWork &&
        includesAnyNormalized(normalized, [
          "remote work setup",
          "mixing travel with work",
          "wifi is listed",
          "wi fi is listed",
          "connectivity only"
        ])
      ) {
        return false;
      }

      if (
        rejectNoise &&
        includesAnyNormalized(normalized, [
          "street activity may be part",
          "lively center",
          "busy central",
          "part of the experience"
        ])
      ) {
        return false;
      }

      if (
        rejectHills &&
        includesAnyNormalized(normalized, [
          "comfortable walking shoes",
          "nearby streets are steep"
        ])
      ) {
        return false;
      }

      if (
        rejectTemperature &&
        includesAnyNormalized(normalized, [
          "warmer lisbon periods",
          "prefer cooler rooms",
          "cooling or fan expectations",
          "temperature comfort appears"
        ])
      ) {
        return false;
      }

      return true;
    }).join(" "))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphs.join("\n\n").trim() || description;
}

function staleGeneratedTopicsForReplacement(selectedTopics: string[]): string[] {
  const stale: string[] = [];

  if (!selectedTopics.some((topic) => topic === "Rated nearby guest options" || topic === "Rated nearby dining options")) {
    stale.push("Rated nearby guest options", "Rated nearby dining options");
  }

  if (!selectedTopics.includes("Noise expectations")) {
    stale.push("Noise expectations");
  }

  if (!selectedTopics.includes("Historic Lisbon hills")) {
    stale.push("Historic Lisbon hills");
  }

  return stale;
}

function sentenceSplit(paragraph: string): string[] {
  const matches = paragraph.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
  return matches?.map((sentence) => sentence.trim()).filter(Boolean) ?? [paragraph.trim()].filter(Boolean);
}

function includesAnyNormalized(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(normalizeTextForCoverage(pattern)));
}

function polishDescriptionCopy(description: string): string {
  return description
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\betc\.\.\.?/gi, "and more.")
    .replace(/\b(\d+)\s+Google reviews\b/gi, "$1 Google review texts in the dataset")
    .replace(/\ba couple of meters\b/gi, "just a few meters")
    .replace(/\bby foot\b/gi, "on foot")
    .replace(/\ball the major city charms\b/gi, "many of Lisbon's main highlights")
    .replace(/\ball the most known neighborhoods\b/gi, "the best-known neighborhoods")
    .replace(/\bneighborhoods as\b/gi, "neighborhoods such as")
    .replace(/\bBy just walking 2 minutes you can reach\b/gi, "Within a 2-minute walk, you can reach")
    .replace(/\bright down the corner\b/gi, "just around the corner")
    .replace(/\bYou will find yourself right in the heart\b/gi, "You are right in the heart")
    .replace(/\bYou will be able to experience\b/gi, "You can experience")
    .replace(/\bwill be able to experience\b/gi, "can experience")
    .replace(/\band You\b/g, "and you")
    .replace(/\.\s+and more\.\s+/gi, ". ")
    .replace(/\band more\s+All\b/g, "and more. All")
    .replace(/\s+([,.])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendTextIfMissing(description: string, addition: string): string {
  if (!addition.trim()) {
    return description;
  }

  if (normalizeTextForCoverage(description).includes(normalizeTextForCoverage(addition))) {
    return description;
  }

  return `${description.trim()}\n\n${addition.trim()}`;
}

function coverageProgressSentence(stats?: ReviewSearchStats): string {
  if (!stats || stats.coverageTotalReviewsInScope === 0) {
    return "";
  }

  return `Review coverage for this audit scope: ${stats.coverageCoveredAfterCount}/${stats.coverageTotalReviewsInScope} review texts have been checked in this demo session. `;
}

function coverageContinuationSentence(stats?: ReviewSearchStats): string {
  if (!stats || stats.coverageTotalReviewsInScope === 0) {
    return "";
  }

  if (stats.coverageComplete) {
    return " The agent has covered all review texts available for this scope in the current demo session.";
  }

  return " Run the same request again to continue into the next unseen review window.";
}

function descriptionAlreadyCoversSignal(description: string, topic: string): boolean {
  const normalized = normalizeTextForCoverage(description);
  const includesAny = (patterns: string[]) => patterns.some((pattern) => normalized.includes(pattern));

  if (topic === "Historic Lisbon hills") {
    return includesAny(["steep", "hill", "comfortable walking shoes", "historic lisbon on foot"]);
  }
  if (topic === "Access and stairs expectations") {
    return includesAny(["comfortable with stairs", "stepped access", "stairs or stepped access", "luggage expectations"]);
  }
  if (topic === "Noise expectations") {
    return includesAny(["lively center", "street activity", "busy central", "part of the experience", "noise expectations"]);
  }
  if (topic === "Temperature expectations") {
    return includesAny(["warmer lisbon", "cooler rooms", "temperature expectations", "plan accordingly"]);
  }
  if (topic === "Space expectations") {
    return includesAny(["smart central base over extra room", "compact", "space is best", "value a smart central base"]);
  }
  if (topic === "Guest-confirmed walkable location") {
    return includesAny(["guests consistently highlight the walkable", "walkable central location", "guest confirmed walkable", "easy to reach lisbon"]);
  }
  if (topic === "Guest-mentioned view") {
    return includesAny(["guest mentioned highlights", "view is one", "lisbon backdrop"]);
  }
  if (topic === "Guest-confirmed cleanliness") {
    return includesAny(["clean and well kept", "reviews repeatedly describe", "guest confirmed cleanliness"]);
  }
  if (topic === "Guest-confirmed comfort") {
    return includesAny(["comfortable stay", "good sleep experience", "guest confirmed comfort"]);
  }
  if (topic === "Remote-work readiness") {
    return includesAny(["remote work setup", "mixing travel with work", "wi fi work setup"]);
  }
  if (topic === "Rated nearby guest options" || topic === "Rated nearby dining options") {
    return includesAny(["highly rated nearby", "google reviews", "nearby dining options", "nearby options such as"]);
  }

  return false;
}

function normalizeTextForCoverage(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-–—]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function uniqueFormattedGooglePlaces(values: string[]): string[] {
  const seen = new Set<string>();
  const places: string[] = [];

  for (const value of values.filter(isFormattedGooglePlace)) {
    const key = value.split("(")[0]?.trim().toLowerCase() || value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      places.push(value);
    }
  }

  return places;
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

  const rationale =
    typeof draft.rationale === "string"
      ? draft.rationale
      : typeof draft.reason === "string"
        ? draft.reason
        : Array.isArray(draft.reasons)
          ? draft.reasons.map((reason) => String(reason)).join(" ")
          : "Supervisor returned a decision without a rationale.";

  return {
    ...draft,
    decision,
    rationale,
    required_change:
      typeof draft.required_change === "string"
        ? draft.required_change
        : typeof draft.revision_instructions === "string"
          ? draft.revision_instructions
          : undefined
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

  if (proposal.action === "restore_previous_page") {
    return {
      decision: "Approve",
      rationale: "The action restores the simulated listing page to the previous in-session text and does not modify reviews, Places data, pricing, or live Airbnb."
    };
  }

  if (proposal.action === "restore_original_page") {
    return {
      decision: "Approve",
      rationale: "The action restores the simulated listing page to the original read-only dataset text and does not modify reviews, Places data, pricing, or live Airbnb."
    };
  }

  if (proposal.action === "replace_description" && proposal.evidence_topics?.includes("Copy polish only")) {
    return {
      decision: "Approve",
      rationale: "The replacement is a copy-polish action that preserves existing facts and updates only the simulated description wording."
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

function proposalCanSkipReviewSignals(proposal: EditProposal): boolean {
  return (
    proposal.action === "restore_previous_page" ||
    proposal.action === "restore_original_page" ||
    (proposal.action === "replace_description" && Boolean(proposal.evidence_topics?.includes("Copy polish only")))
  );
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
    if (state.proposal?.action === "restore_previous_page") {
      return [
        `Approved and executed in the demo environment for listing ${state.listing.id}: ${state.listing.name}.`,
        "",
        "The simulated listing description was restored to the previous version text.",
        "",
        "No source CSV, guest review, Google Places row, or live Airbnb account was changed. The restore action was recorded in the audit log."
      ].join("\n");
    }

    if (state.proposal?.action === "restore_original_page") {
      return [
        `Approved and executed in the demo environment for listing ${state.listing.id}: ${state.listing.name}.`,
        "",
        "The simulated listing description was restored to the original dataset text.",
        "",
        "No source CSV, guest review, Google Places row, or live Airbnb account was changed. The restore action was recorded in the audit log."
      ].join("\n");
    }

    if (state.proposal?.action === "replace_description") {
      return [
        `Approved and executed in the demo environment for listing ${state.listing.id}: ${state.listing.name}.`,
        "",
        state.proposal.evidence_topics?.includes("Copy polish only")
          ? "What changed: the agent rewrote the current description wording to make it more natural and persuasive, without adding new facts."
          : "What changed: the agent replaced the current description with a safer evidence-backed version instead of only appending text.",
        "",
        `Why this improves the page: ${pageEditBenefit(state)}`,
        "",
        `Evidence used: ${pageEditEvidenceSummary(state)}`,
        "",
        "No live Airbnb account was accessed. The update was applied only to the simulated listing page and recorded in the audit log."
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

  if (state.pageUpdate?.status === "not_executed") {
    const reason =
      state.supervisor?.decision === "Block"
        ? state.supervisor.rationale
        : state.pageUpdate.reason ?? state.proposal?.reason ?? state.supervisor?.rationale ?? "No effective page change was available.";
    return [
      `No new page update was executed for listing ${state.listing.id}: ${state.listing.name}.`,
      "",
      reason,
      "",
      state.proposal?.evidence_topics?.length
        ? `Evidence considered: ${state.proposal.evidence_topics.join("; ")}.`
        : "The agent stopped without changing the current simulated description.",
      "",
      "No live Airbnb account was accessed. Source reviews, Google Places rows, pricing, bookings, and guest reviews remained read-only."
    ].join("\n");
  }

  if (state.supervisor?.decision === "Revise") {
    return `The Supervisor requested revision for listing ${state.listing.id}. The agent replanned once and stopped because a safe approved edit was not available. No live Airbnb account was accessed.`;
  }

  if (state.supervisor?.decision === "Block") {
    return `No page update was executed for listing ${state.listing.id}: ${state.listing.name}. Supervisor blocked the action: ${state.supervisor.rationale} No live Airbnb account was accessed.`;
  }

  if (state.stopReason) {
    return `${state.stopReason} No live Airbnb account was accessed, and no simulated page update was executed.`;
  }

  return `No action was taken for listing ${state.listing.id}. The agent did not find enough validated evidence for a safe page update. No live Airbnb account was accessed.`;
}

function pageEditBenefit(state: AgentState): string {
  const topics = state.proposal?.evidence_topics ?? [];

  if (topics.includes("Copy polish only")) {
    return "it makes the existing page copy easier to read and more persuasive while preserving the listing's current facts.";
  }

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

  if (topics.includes("Copy polish only")) {
    return "No new evidence retrieval was needed; the tool preserved the current simulated page facts and only improved wording.";
  }

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
  return isRestorePreviousRequest(state) || isRestoreOriginalRequest(state);
}

function isRestorePreviousRequest(state: AgentState): boolean {
  return state.intent.includes("restore_previous") || /\b(previous version|previous text|last version|last edit|one version back|undo last)\b/i.test(state.prompt);
}

function isRestoreOriginalRequest(state: AgentState): boolean {
  return /\b(original dataset|original text|dataset text|back to original|reset to original|source text)\b/i.test(state.prompt);
}

function isCopyPolishRequest(state: AgentState): boolean {
  const nearbyPlacesRequest =
    state.intent.includes("nearby_highlights") &&
    /\b(nearby places|google places|within\s+(?:about\s+)?\d+(?:\.\d+)?\s*(?:km|kilometers?)|rating|google review count)\b/i.test(
      state.prompt
    );
  const explicitCopyPolish = /\b(polish|rewrite|make natural|more natural|stronger copy|marketing copy|persuasive copy|copy wording|wording|tone|sell better)\b/i.test(
    state.prompt
  );

  if (nearbyPlacesRequest && !explicitCopyPolish) {
    return false;
  }

  return state.intent.includes("copy_polish") || explicitCopyPolish;
}

function isPortfolioRequest(prompt: string): boolean {
  return /\b(portfolio|managed listings|managed properties|properties I manage|listings I manage)\b/i.test(prompt) ||
    /\b(?:all|every)\s+(?:of\s+my\s+|my\s+|managed\s+)?(?:airbnb\s+)?(?:listings|properties|rentals)\b/i.test(prompt) ||
    /כל הנכסים|כל הדירות|כל הרשימות|בבעלותי|שבבעלותי/.test(prompt);
}

function portfolioPromptForListing(prompt: string, listingName: string): string {
  if (/\b(original dataset|original text|dataset text|back to original|reset to original|source text)\b/i.test(prompt)) {
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
    has_previous_page_version: Boolean(state.previousDescriptionOverride),
    has_claims: Boolean(state.claims),
    has_review_observations: Boolean(state.relevantReviews),
    review_search_stats: state.reviewSearchStats
      ? {
          strategy: state.reviewSearchStats.strategy,
          coverage_scope_key: state.reviewSearchStats.coverageScopeKey,
          coverage_checked: state.reviewSearchStats.coverageCoveredAfterCount,
          coverage_total: state.reviewSearchStats.coverageTotalReviewsInScope,
          coverage_complete: state.reviewSearchStats.coverageComplete
        }
      : null,
    has_google_places_context: Boolean(state.relevantPlaces),
    has_signals: Boolean(state.signals),
    has_proposal: Boolean(state.proposal),
    supervisor_decision: state.supervisor?.decision,
    revise_count: state.reviseCount,
    runtime_observations: state.observations,
    terminal_reason: state.stopReason
  });
}

function auditEvidenceSummary(state: AgentState): Record<string, unknown> {
  return {
    review_rag_source: state.reviewSource ?? null,
    pinecone_filter: state.listing
      ? {
          listing_id: state.listing.id,
          source: "airbnb_review"
        }
      : null,
    embedding_model: process.env.LLMOD_EMBEDDING_MODEL || "MB5R2CF-azure/text-embedding-3-small",
    indexed_review_text_count: state.indexedReviewTextCount ?? null,
    retrieved_review_count: state.reviews?.length ?? null,
    relevant_review_count: state.relevantReviews?.length ?? null,
    search_stats: state.reviewSearchStats
      ? {
          strategy: state.reviewSearchStats.strategy,
          queries_run: state.reviewSearchStats.queriesRun,
          coverage_checked: state.reviewSearchStats.coverageCoveredAfterCount,
          coverage_total: state.reviewSearchStats.coverageTotalReviewsInScope,
          coverage_complete: state.reviewSearchStats.coverageComplete
        }
      : null,
    signals: state.signals ?? []
  };
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
