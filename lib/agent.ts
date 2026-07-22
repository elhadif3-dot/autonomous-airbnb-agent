import {
  getListingById,
  getListings,
  getPlacesNearListing,
  getReviewsForListing
} from "@/lib/data";
import { enforceGuardrails, validateProposal } from "@/lib/guardrails";
import { callLlmJson } from "@/lib/llmClient";
import { LISTING_EDITOR_SYSTEM_PROMPT, SUPERVISOR_SYSTEM_PROMPT } from "@/lib/prompts";
import type { AgentIntentPlan, EditProposal, SupervisorOutput } from "@/lib/schemas";
import type { AgentStep, ExecuteResponse, Listing, Place, Review, SupervisorDecision } from "@/lib/types";

type Signal = {
  type: "positive_highlight" | "accuracy_gap" | "insufficient_evidence";
  topic: string;
  evidenceCount: number;
  evidence: string[];
  recommendation: string;
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

export async function executeListingAgent(prompt: string): Promise<ExecuteResponse> {
  const steps: AgentStep[] = [];

  try {
    const listing = await resolveListing(prompt);
    if (!listing) {
      return {
        status: "error",
        error: "No Lisbon listing could be resolved from the prompt.",
        response: null,
        steps
      };
    }

    const intent = inferIntent(prompt);
    const intentPlan = await callLlmJson<AgentIntentPlan>({
      module: "Autonomous Listing Editor Agent",
      messages: [
        { role: "system", content: LISTING_EDITOR_SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      mockResponse: {
        selected_listing_id: listing.id,
        inferred_intent: intent,
        selected_tools: chooseActions(intent),
        rationale: "Mock reasoning selected tools according to prompt intent and listing context. No LLM call was made."
      }
    });

    steps.push(step("Autonomous Listing Editor Agent", LISTING_EDITOR_SYSTEM_PROMPT, prompt, {
      selected_listing_id: listing.id,
      selected_listing_name: listing.name,
      inferred_intent: intentPlan.inferred_intent,
      selected_tools: intentPlan.selected_tools,
      rationale: intentPlan.rationale,
      llm_mode: process.env.LLM_MODE === "live" ? "live_requested" : "mock"
    }));

    const reviews = await getReviewsForListing(listing.id);
    steps.push(step("Listing Tools", "Retrieve structured listing data and extract current page claims.", `Listing id: ${listing.id}`, {
      listing_id: listing.id,
      current_claims: extractClaims(listing),
      review_count_available: reviews.length
    }));

    const relevantReviews = searchRelevantReviews(reviews, intent);
    steps.push(step("Review RAG", "Search guest reviews for signals relevant to the observed gap.", `Intent: ${intent.join(", ")}`, {
      retrieved_reviews: relevantReviews.map((review) => ({
        date: review.date,
        excerpt: excerpt(review.comments)
      })),
      retrieval_note: "Airbnb reviews are treated as the primary evidence source."
    }));

    const places = await getPlacesNearListing(listing, 40);
    const relevantPlaces = filterRelevantPlaces(places, intent);
    steps.push(step("Google Places Context", "Use nearby places only as environmental context, not as primary proof.", `Listing coordinates: ${listing.latitude}, ${listing.longitude}`, {
      nearby_places: relevantPlaces.map((place) => ({
        name: place.placeName,
        category: place.category,
        rating: place.rating,
        distance_km: Number(place.distanceKm?.toFixed(2))
      }))
    }));

    const signals = detectSignals(listing, relevantReviews, relevantPlaces, intent);
    steps.push(step("Edit & Decision Tools", "Draft a page edit or stop if the evidence is weak.", `Signals from reviews and places: ${signals.map((signal) => signal.topic).join(", ")}`, {
      signals,
      proposed_action: draftEdit(listing, signals)
    }));

    const proposal = draftEdit(listing, signals);
    const guardrails = validateProposal(proposal);
    const supervisorDraft = await callLlmJson<SupervisorOutput>({
      module: "Supervisor / Control Agent",
      messages: [
        { role: "system", content: SUPERVISOR_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ proposal, signals, guardrails }) }
      ],
      mockResponse: supervise(proposal, signals)
    });
    const supervisor = enforceGuardrails(proposal, supervisorDraft);
    steps.push(step("Supervisor / Control Agent", SUPERVISOR_SYSTEM_PROMPT, JSON.stringify({ proposal, signals, guardrails }), {
      ...supervisor,
      guardrails
    }));

    const response = finalResponse(listing, proposal, supervisor.decision);
    steps.push(step("Audit Log", "Record the simulated outcome for the property manager.", `Decision: ${supervisor.decision}`, {
      listing_id: listing.id,
      listing_name: listing.name,
      decision: supervisor.decision,
      executed_in_demo_environment: supervisor.decision === "Approve",
      live_airbnb_updated: false
    }));

    return {
      status: "ok",
      error: null,
      response,
      steps
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown execution error",
      response: null,
      steps
    };
  }
}

async function resolveListing(prompt: string): Promise<Listing | null> {
  const idMatch = prompt.match(/\b\d{8,}\b/);
  if (idMatch) {
    const listing = await getListingById(idMatch[0]);
    if (listing) {
      return listing;
    }
  }

  const listings = await getListings(1);
  return listings[0] ?? null;
}

function inferIntent(prompt: string): string[] {
  const normalized = prompt.toLowerCase();
  const topics = Object.entries(topicKeywords)
    .filter(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword)))
    .map(([topic]) => topic);

  if (topics.length > 0) {
    return topics;
  }

  return ["location", "noise", "nearby_highlights", "wifi"];
}

function chooseActions(intent: string[]): string[] {
  const actions = ["get_listing_data", "extract_claims", "search_reviews"];
  if (intent.includes("location") || intent.includes("noise") || intent.includes("nearby_highlights")) {
    actions.push("get_google_places", "compare_location_context");
  }
  actions.push("draft_listing_edit", "submit_to_supervisor");
  return actions;
}

function extractClaims(listing: Listing): Record<string, unknown> {
  const description = listing.description.toLowerCase();
  return {
    mentions_quiet: description.includes("quiet"),
    mentions_nightlife: description.includes("nightlife") || description.includes("entertainment"),
    mentions_hills: description.includes("hill") || description.includes("steep"),
    mentions_wifi: description.includes("wifi") || listing.amenities.some((amenity) => amenity.toLowerCase().includes("wifi")),
    mentions_nearby_attractions:
      description.includes("restaurant") ||
      description.includes("park") ||
      description.includes("museum") ||
      description.includes("attraction"),
    amenities: listing.amenities.slice(0, 8)
  };
}

function searchRelevantReviews(reviews: Review[], intent: string[]): Review[] {
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

  return (matches.length > 0 ? matches : reviews).slice(0, 6);
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

function detectSignals(listing: Listing, reviews: Review[], places: Place[], intent: string[]): Signal[] {
  const signals: Signal[] = [];
  const reviewText = reviews.map((review) => review.comments.toLowerCase()).join(" ");
  const description = listing.description.toLowerCase();

  if (intent.includes("hills") || reviewText.includes("hill") || reviewText.includes("steep")) {
    const evidence = reviews
      .filter((review) => /hill|steep|walk up|climb/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 1 && !description.includes("hill") && !description.includes("steep")) {
      signals.push({
        type: "accuracy_gap",
        topic: "Historic Lisbon hills",
        evidenceCount: evidence.length,
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
        evidence,
        recommendation: "Soften quiet claims and set accurate expectations about the street environment."
      });
    }
  }

  if (intent.includes("wifi") || reviewText.includes("wifi") || reviewText.includes("internet")) {
    const evidence = reviews
      .filter((review) => /wifi|wi-fi|internet|remote|work/i.test(review.comments))
      .map((review) => excerpt(review.comments));
    if (evidence.length >= 2) {
      signals.push({
        type: "positive_highlight",
        topic: "Remote-work readiness",
        evidenceCount: evidence.length,
        evidence,
        recommendation: "Mention verified Wi-Fi/work setup only if the listing amenities already support it."
      });
    }
  }

  if (intent.includes("nearby_highlights") && places.length > 0 && !description.includes("nearby highlights")) {
    const topPlaces = places.slice(0, 3).map((place) => place.placeName);
    signals.push({
      type: "positive_highlight",
      topic: "Nearby guest highlights",
      evidenceCount: places.length,
      evidence: topPlaces,
      recommendation: "Add a concise nearby highlights note based on highly rated Google Places context."
    });
  }

  if (signals.length === 0) {
    signals.push({
      type: "insufficient_evidence",
      topic: "No strong editable gap",
      evidenceCount: reviews.length,
      evidence: reviews.slice(0, 2).map((review) => excerpt(review.comments)),
      recommendation: "Stop without editing because the agent cannot justify a page update."
    });
  }

  return signals;
}

function draftEdit(listing: Listing, signals: Signal[]): EditProposal {
  const editableSignals = signals.filter((signal) => signal.type !== "insufficient_evidence");

  if (editableSignals.length === 0) {
    return {
      action: "stop_without_action",
      reason: "No strong, editable gap was found.",
      proposed_description_addition: null,
      target_fields: []
    };
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
      return `Nearby highlights: ${signal.evidence.slice(0, 3).join(", ")} are located within the surrounding Lisbon area.`;
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

function supervise(proposal: ReturnType<typeof draftEdit>, signals: Signal[]): {
  decision: SupervisorDecision;
  rationale: string;
  required_change?: string;
} {
  if (proposal.action === "stop_without_action") {
    return {
      decision: "Block",
      rationale: "The agent did not find enough evidence for an autonomous page edit."
    };
  }

  const hasEvidence = signals.some((signal) => signal.type === "accuracy_gap" && signal.evidenceCount >= 1);
  const hasPositiveContext = signals.some((signal) => signal.type === "positive_highlight" && signal.evidenceCount >= 3);

  if (hasEvidence || hasPositiveContext) {
    return {
      decision: "Approve",
      rationale: "The proposal is narrow, evidence-backed, and updates only the simulated listing page."
    };
  }

  return {
    decision: "Revise",
    rationale: "The proposal may be useful, but the evidence is not strong enough yet.",
    required_change: "Retrieve more guest-review evidence or narrow the edit."
  };
}

function finalResponse(
  listing: Listing,
  proposal: ReturnType<typeof draftEdit>,
  decision: SupervisorDecision
): string {
  if (decision === "Approve") {
    return [
      `Approved and executed in the demo environment for listing ${listing.id}: ${listing.name}.`,
      "",
      `Updated field: ${proposal.target_fields.join(", ")}.`,
      `Added text: ${proposal.proposed_description_addition}`,
      "",
      "No live Airbnb account was accessed. The update was applied only to the simulated listing page and recorded in the audit log."
    ].join("\n");
  }

  if (decision === "Revise") {
    return `The Supervisor returned the action for replanning. The agent should gather stronger evidence before editing listing ${listing.id}.`;
  }

  return `No action was taken for listing ${listing.id}. The Supervisor blocked the edit because the evidence did not justify changing the simulated listing page.`;
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

function excerpt(value: string, length = 220): string {
  return value.length > length ? `${value.slice(0, length).trim()}...` : value;
}
