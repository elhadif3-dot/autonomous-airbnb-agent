"use client";

import { useMemo, useState } from "react";
import {
  Bath,
  BedDouble,
  BriefcaseBusiness,
  ChevronDown,
  CircleParking,
  Coffee,
  CookingPot,
  DoorOpen,
  Dumbbell,
  Heart,
  Home,
  MapPin,
  Medal,
  MessageSquareText,
  Search,
  Share,
  ShieldCheck,
  Sparkles,
  Star,
  Tv,
  UserRound,
  Users,
  WashingMachine,
  Waves,
  Wifi,
  Wind
} from "lucide-react";
import type { AgentStep, ExecuteResponse, Listing, Review } from "@/lib/types";

type DemoListing = Listing & {
  recentReviews: Review[];
  indexedReviewTextCount: number;
};

type ListingOption = Pick<
  Listing,
  "id" | "name" | "neighbourhood" | "numberOfReviews" | "nearbyPlacesCount" | "reviewScore"
>;

type Props = {
  initialListings: DemoListing[];
  listingOptions: ListingOption[];
  managedCount: number;
  totalDatasetListings: number;
};

type TraceSummary = {
  title: string;
  action?: string;
  rationale?: string;
  observation?: string;
  decision?: string;
  status?: string;
};

const defaultPrompt =
  "Hi, I manage several Airbnb listings in Lisbon. For the selected listing, autonomously review the listing page against guest reviews and nearby context. If you find an evidence-backed improvement, update the simulated page end to end and explain what changed.";

function promptExamples(listingName: string) {
  return [
    {
      label: "Improve end to end",
      hint: "Find review gaps, edit the page, explain why",
      prompt: `Hi, I manage several Airbnb listings in Lisbon. Please handle "${listingName}" end to end: compare the current page with guest reviews first, use nearby context only when useful, decide what is safe to improve, update the simulated listing page, and tell me exactly what changed.`
    },
    {
      label: "Use guest review gaps",
      hint: "Add or correct text from guest experience",
      prompt: `For "${listingName}", focus on gaps between the listing description and actual guest reviews. Look for repeated signals about stairs, hills, temperature, noise, comfort, cleanliness, view, Wi-Fi, or location. If the evidence is strong, edit the simulated page and explain the improvement.`
    },
    {
      label: "Fix expectation mismatch",
      hint: "Correct overpromising or vague wording",
      prompt: `Review "${listingName}" for a mismatch between what the page promises and what guests actually report, especially quietness, access, stairs, hills, heat, Wi-Fi, or comfort. If the evidence is strong, make a narrow expectation-setting edit.`
    },
    {
      label: "Add nearby value",
      hint: "Use Places only as supporting context",
      prompt: `For "${listingName}", find positive nearby value missing from the page. Use Airbnb location reviews as primary evidence and Google Places only as supporting context. If approved, add concise guest-facing text to the simulated page.`
    },
    {
      label: "Find property fixes",
      hint: "Recommend fixes from guest complaints",
      prompt: `For "${listingName}", do not edit the page. Use guest reviews to tell me which fixable property or operations issues are bothering guests, what I should improve first, and why it could improve reviews, bookings, or listing quality.`
    },
    {
      label: "Find more evidence",
      hint: "Gather review examples, no page edit",
      prompt: `For "${listingName}", can you find more evidence for a repeated guest issue, especially Wi-Fi, noise, temperature, stairs, space, or comfort? Return review examples only and do not edit the simulated page.`
    },
    {
      label: "Undo last page edit",
      hint: "Restore original dataset text",
      prompt: `I did not like the simulated edit on "${listingName}". Restore this listing page to the original dataset text and record what you restored.`
    }
  ];
}

export function DemoDashboard({ initialListings, listingOptions, totalDatasetListings }: Props) {
  const [listings, setListings] = useState(initialListings);
  const [selectedId, setSelectedId] = useState(initialListings[0]?.id ?? listingOptions[0]?.id ?? "");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingListing, setIsLoadingListing] = useState(false);
  const [simulatedDescriptions, setSimulatedDescriptions] = useState<Record<string, string>>({});
  const [visibleReviews, setVisibleReviews] = useState<Record<string, number>>({});

  const selectedListing = useMemo(
    () => listings.find((listing) => listing.id === selectedId),
    [listings, selectedId]
  );

  const examples = useMemo(
    () => promptExamples(selectedListing?.name ?? "this listing"),
    [selectedListing?.name]
  );

  async function selectListing(id: string) {
    setSelectedId(id);
    setResult(null);

    if (listings.some((listing) => listing.id === id)) {
      return;
    }

    setIsLoadingListing(true);
    try {
      const response = await fetch(`/api/listings?id=${encodeURIComponent(id)}`);
      const payload = (await response.json()) as { status: string; listing?: DemoListing; error?: string };
      if (payload.status === "ok" && payload.listing) {
        setListings((current) => [...current, payload.listing!]);
      }
    } finally {
      setIsLoadingListing(false);
    }
  }

  async function runAgent() {
    if (!selectedListing) {
      return;
    }

    setIsRunning(true);
    setResult(null);
    const portfolioPageDescriptions = initialListings.reduce<Record<string, string>>((values, listing) => {
      values[listing.id] = simulatedDescriptions[listing.id] ?? listing.description;
      return values;
    }, {});

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: `Selected listing id: ${selectedListing.id}\n${prompt}`,
          current_page_description: currentDescription,
          portfolio_page_descriptions: portfolioPageDescriptions
        })
      });

      const payload = (await response.json().catch(() => ({
        status: "error",
        error: `The agent returned HTTP ${response.status}, but the response body was not valid JSON.`,
        response: null,
        steps: [],
        page_update: null,
        portfolio_update: null,
        audit_log: null
      }))) as ExecuteResponse;

      setResult(payload);
      if (payload.page_update?.status === "executed" && payload.page_update.after) {
        setSimulatedDescriptions((current) => ({
          ...current,
          [payload.page_update!.listingId]: payload.page_update!.after!
        }));
      }
      if (payload.portfolio_update?.results) {
        setSimulatedDescriptions((current) => {
          const next = { ...current };
          for (const item of payload.portfolio_update?.results ?? []) {
            if (item.status === "executed" && item.after) {
              next[item.listingId] = item.after;
            }
          }
          return next;
        });
      }
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      setResult({
        status: "error",
        error: timedOut
          ? "The agent request took more than 90 seconds and was stopped in the demo UI. Try a single listing request or rerun after the current deployment is ready."
          : error instanceof Error
            ? error.message
            : "The agent request failed before a response was received.",
        response: null,
        steps: [],
        page_update: null,
        portfolio_update: null,
        audit_log: null
      });
    } finally {
      window.clearTimeout(timeoutId);
      setIsRunning(false);
    }
  }

  async function resetPage() {
    if (!selectedListing) {
      return;
    }

    await fetch("/api/demo_reset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ listing_id: selectedListing.id })
    });

    setSimulatedDescriptions((current) => ({
      ...current,
      [selectedListing.id]: selectedListing.description
    }));
    setResult(null);
  }

  if (!selectedListing) {
    return (
      <div className="airbnbPage">
        <Header
          listingOptions={listingOptions}
          selectedId={selectedId}
          onSelect={selectListing}
          totalDatasetListings={totalDatasetListings}
        />
        <main className="listingShell">
          <div className="loadingListing">{isLoadingListing ? "Loading selected listing..." : "No listing available."}</div>
        </main>
      </div>
    );
  }

  const currentDescription = simulatedDescriptions[selectedListing.id] ?? selectedListing.description;

  return (
    <div className="airbnbPage">
      <Header
        listingOptions={listingOptions}
        selectedId={selectedId}
        onSelect={selectListing}
        totalDatasetListings={totalDatasetListings}
      />

      <main className="listingShell">
        <section className="listingTitleBlock">
          <div>
            <h1>{selectedListing.name}</h1>
            <div className="listingSubline">
              <span>
                <Star size={16} fill="currentColor" /> {selectedListing.reviewScore?.toFixed(2) ?? "New"}
              </span>
              <span>{selectedListing.numberOfReviews} reviews</span>
              <span>{selectedListing.neighbourhood}, Lisbon</span>
            </div>
          </div>
          <div className="titleActions">
            <button type="button">
              <Share size={16} /> Share
            </button>
            <button type="button">
              <Heart size={16} /> Save
            </button>
          </div>
        </section>

        <Gallery listing={selectedListing} />

        <div className="contentGrid">
          <article className="listingContent">
            <section className="hostSection">
              <div>
                <h2>
                  {selectedListing.roomType} in {selectedListing.neighbourhood}
                </h2>
                <p>
                  {selectedListing.accommodates} guests | {selectedListing.bedrooms ?? "N/A"} bedrooms |{" "}
                  {selectedListing.beds ?? "N/A"} beds | {selectedListing.bathroomsText}
                </p>
              </div>
              <div className="hostAvatar">
                <UserRound size={24} />
              </div>
            </section>

            <section className="trustStrip">
              <TrustItem icon={<Medal size={24} />} title="Guest experience signals" text={`${selectedListing.numberOfReviews} Airbnb reviews`} />
              <TrustItem icon={<MapPin size={24} />} title="Agent location context" text={`${selectedListing.nearbyPlacesCount} nearby places available to the agent`} />
              <TrustItem icon={<ShieldCheck size={24} />} title="Supervisor controlled" text="No page edit without approval" />
            </section>

            <section className="listingSection">
              <h2>About this place</h2>
              <p className="descriptionText">{currentDescription}</p>
              <EditableHighlights description={currentDescription} />
            </section>

            <section className="listingSection">
              <h2>What this place offers</h2>
              <Amenities amenities={selectedListing.amenities} />
            </section>

            <section className="listingSection">
              <div className="sectionHeaderRow">
                <div>
                  <h2>Guest reviews</h2>
                  <p>
                    {selectedListing.indexedReviewTextCount} review texts are available for this listing in the read-only review index. This page previews {selectedListing.recentReviews.length} examples; the agent retrieves relevant evidence from the full index when it runs.
                  </p>
                </div>
                <Star size={22} />
              </div>
              <ReviewList
                reviews={selectedListing.recentReviews}
                totalReviews={selectedListing.numberOfReviews}
                indexedReviewTextCount={selectedListing.indexedReviewTextCount}
                visibleCount={visibleReviews[selectedListing.id] ?? 4}
                onLoadMore={() =>
                  setVisibleReviews((current) => ({
                    ...current,
                    [selectedListing.id]: Math.min(
                      (current[selectedListing.id] ?? 4) + 4,
                      selectedListing.recentReviews.length
                    )
                  }))
                }
              />
            </section>
          </article>

          <aside className="sideRail">
            <AgentFeatureBar
              prompt={prompt}
              setPrompt={setPrompt}
              runAgent={runAgent}
              resetPage={resetPage}
              isRunning={isRunning}
              result={result}
              examples={examples}
            />
            <ReservationCard listing={selectedListing} />
          </aside>
        </div>
      </main>
    </div>
  );
}

function Header({
  listingOptions,
  selectedId,
  onSelect,
  totalDatasetListings
}: {
  listingOptions: ListingOption[];
  selectedId: string;
  onSelect: (id: string) => void | Promise<void>;
  totalDatasetListings: number;
}) {
  return (
    <header className="airbnbHeader">
      <div className="airbnbLogo">
        <Home size={26} />
        <span>airbnb</span>
      </div>
      <div className="searchPill">
        <select value={selectedId} onChange={(event) => void onSelect(event.target.value)} aria-label="Choose listing from dataset">
          {listingOptions.map((listing) => (
            <option key={listing.id} value={listing.id}>
              {listing.name} | {listing.numberOfReviews} reviews
            </option>
          ))}
        </select>
        <span>Lisbon</span>
        <span>{totalDatasetListings.toLocaleString()} dataset listings</span>
        <button type="button" aria-label="Search">
          <Search size={17} />
        </button>
      </div>
      <div className="managerBadge">Property manager demo</div>
    </header>
  );
}

function AgentFeatureBar({
  prompt,
  setPrompt,
  runAgent,
  resetPage,
  isRunning,
  result,
  examples
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  runAgent: () => void;
  resetPage: () => void;
  isRunning: boolean;
  result: ExecuteResponse | null;
  examples: ReturnType<typeof promptExamples>;
}) {
  return (
    <section className="agentDock">
      <div className="agentDockIntro">
        <div className="agentIconBubble">
          <MessageSquareText size={20} />
        </div>
        <div>
          <span className="agentEyebrow">Autonomous Listing Editor</span>
          <h2>Ask the agent to update this page</h2>
          <p>Give a property-manager request. The agent chooses actions, edits the simulated page, and explains the result.</p>
        </div>
      </div>

      <div className="promptExamples">
        {examples.map((example) => (
          <button type="button" key={example.label} onClick={() => setPrompt(example.prompt)}>
            <strong>{example.label}</strong>
            <span>{example.hint}</span>
          </button>
        ))}
      </div>

      <label className="promptLabel" htmlFor="agent-prompt">
        Open end-to-end request
      </label>
      <textarea
        id="agent-prompt"
        className="promptBox"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        aria-label="Agent prompt"
      />

      <div className="scopeBox">
        <div>
          <strong>Can edit</strong>
          <span>Description, guest expectation notes, nearby highlights text</span>
        </div>
        <div>
          <strong>Read-only</strong>
          <span>Reviews, original CSV data, prices, bookings, Google Places source rows</span>
        </div>
      </div>

      <div className="agentActions">
        <button className="primaryButton" type="button" onClick={runAgent} disabled={isRunning}>
          {isRunning ? "Running..." : "Run Agent"}
        </button>
        <button className="ghostButton" type="button" onClick={resetPage}>
          Reset Page
        </button>
      </div>

      {!result ? (
        <div className="emptyState">
          Action Trace will show the actions the agent selected, tool observations, Supervisor decision, page update, and audit log.
        </div>
      ) : (
        <AgentResult result={result} />
      )}
    </section>
  );
}

function Gallery({ listing }: { listing: DemoListing }) {
  const labels = [
    listing.propertyType,
    listing.roomType,
    `${listing.neighbourhood} stay`,
    `${listing.accommodates} guests`,
    "Lisbon context"
  ];

  return (
    <section className="photoGrid" aria-label="Demo listing gallery">
      {labels.map((label, index) => (
        <div className={`photoTile photoTile${index + 1}`} key={label}>
          <span>{label}</span>
          {index === labels.length - 1 ? (
            <button type="button">
              <Sparkles size={16} /> Demo photos
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function TrustItem({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="trustItem">
      {icon}
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function Amenities({ amenities }: { amenities: string[] }) {
  return (
    <div className="amenityGrid">
      {amenities.slice(0, 10).map((amenity) => (
        <div className="amenityItem" key={amenity}>
          {amenityIcon(amenity)}
          <span>{amenity}</span>
        </div>
      ))}
    </div>
  );
}

function EditableHighlights({ description }: { description: string }) {
  const highlights = extractNearbyHighlights(description);
  if (!highlights) {
    return null;
  }

  return (
    <div className="editableHighlightBlock">
      <div>
        <Sparkles size={20} />
        <strong>Added by the agent</strong>
      </div>
      <p>{highlights}</p>
    </div>
  );
}

function ReservationCard({ listing }: { listing: DemoListing }) {
  return (
    <section className="reservationCard">
      <div className="priceLine">
        <strong>{listing.price || "N/A"}</strong>
        <span>night</span>
      </div>
      <div className="bookingBox">
        <div>
          <span>Check-in</span>
          <strong>Demo</strong>
        </div>
        <div>
          <span>Check-out</span>
          <strong>Demo</strong>
        </div>
        <div className="guestRow">
          <span>Guests</span>
          <strong>
            {listing.accommodates} guests <ChevronDown size={14} />
          </strong>
        </div>
      </div>
      <button type="button" className="reserveButton">
        Simulated page only
      </button>
      <p>No live Airbnb account, pricing, or booking action is used.</p>
    </section>
  );
}

function AgentResult({ result }: { result: ExecuteResponse }) {
  const supervisorStep = result.steps.find((step) => step.module === "Supervisor / Control Agent");
  const decision = getDecision(supervisorStep);
  const evidenceTopics = getEvidenceTopics(result.audit_log?.proposal);

  return (
    <div className="result">
      <div className="responseBox">
        <h4>Agent response</h4>
        {decision ? <span className={`decision ${decision.toLowerCase()}`}>{decision}</span> : null}
        <p>{result.response ?? result.error}</p>
      </div>

      {result.page_update ? (
        <div className="auditBox">
          <h4>End-to-end page result</h4>
          <p>Status: {result.page_update.status}</p>
          {result.page_update.status === "executed" ? (
            <p>
              The agent completed the request on the simulated page, updated only the allowed listing text, and kept the source
              reviews, CSV rows, Places data, booking data, and pricing read-only.
            </p>
          ) : null}
          {evidenceTopics.length > 0 ? <p>Why this helps: {evidenceTopics.join(", ")}.</p> : null}
          {result.page_update.status === "executed" ? (
            <div className="diffGrid">
              <div>
                <strong>Before</strong>
                <p>{result.page_update.before}</p>
              </div>
              <div>
                <strong>After</strong>
                <p>{result.page_update.after}</p>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {result.manager_recommendations?.length ? (
        <div className="auditBox">
          <h4>Property improvement recommendations</h4>
          <p>
            The agent did not edit the page here. It used read-only guest reviews to identify fixable issues that may
            improve guest experience, review quality, and booking confidence.
          </p>
          <div className="recommendationList">
            {result.manager_recommendations.map((item) => (
              <article className="recommendationItem" key={`${item.topic}-${item.priority}`}>
                <div>
                  <strong>{item.topic}</strong>
                  <span className={`priorityBadge ${item.priority}`}>{item.priority}</span>
                </div>
                <p>
                  <b>Guest signal:</b> {item.guestSignal} ({item.evidenceCount} review signals)
                </p>
                <p>
                  <b>Recommended action:</b> {item.suggestedAction}
                </p>
                <p>
                  <b>Why it helps:</b> {item.businessValue}
                </p>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {result.evidence_report ? (
        <div className="auditBox">
          <h4>Evidence report</h4>
          <p>
            The agent gathered read-only guest-review evidence for <b>{result.evidence_report.topic}</b> and did not edit the simulated page.
          </p>
          <p>
            Retrieved {result.evidence_report.retrievedReviewCount} relevant reviews from {result.evidence_report.indexedReviewTextCount} indexed review texts. Matching evidence found: {result.evidence_report.matchingEvidenceCount}.
          </p>
          <div className="recommendationList">
            {result.evidence_report.evidence.map((item, index) => (
              <article className="recommendationItem" key={`${result.evidence_report?.topic}-${index}`}>
                <p>{item}</p>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {result.portfolio_update ? (
        <div className="auditBox">
          <h4>Portfolio result</h4>
          <p>
            {result.portfolio_update.executed} of {result.portfolio_update.requestedListings} managed listings were updated in the current demo session.
            {result.portfolio_update.skipped > 0 ? ` ${result.portfolio_update.skipped} were left unchanged.` : ""}
          </p>
          <div className="portfolioList">
            {result.portfolio_update.results.map((item) => (
              <article className="portfolioItem" key={item.listingId}>
                <div>
                  <strong>{item.listingName}</strong>
                  <span>{item.listingId}</span>
                </div>
                <span className={`portfolioStatus ${item.status}`}>{item.status}</span>
                {item.addedText ? <p>{item.addedText}</p> : <p>{item.response}</p>}
                {item.response ? <p className="whyLine">{extractWhyLine(item.response)}</p> : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {result.audit_log ? (
        <div className="auditBox">
          <h4>Audit log</h4>
          <p>
            {result.audit_log.createdAt} | {result.audit_log.decision} | liveAirbnbUpdated=
            {String(result.audit_log.liveAirbnbUpdated)}
          </p>
        </div>
      ) : null}

      <div className="stepList">
        <h4>Action Trace</h4>
        {result.steps.map((step, index) => {
          const summary = summarizeTraceStep(step);

          return (
          <details
            className="stepBox"
            key={`${step.module}-${index}`}
            open={index < 2 || step.module.includes("Supervisor") || index === result.steps.length - 1}
          >
            <summary>
              <span>Action {index + 1}</span>
              <strong>{summary.title}</strong>
            </summary>
            <div className="traceSummary">
              <div className="traceModule">{step.module}</div>
              {summary.action ? <div>Selected action: <strong>{summary.action}</strong></div> : null}
              {summary.decision ? <div>Supervisor decision: <strong>{summary.decision}</strong></div> : null}
              {summary.status ? <div>Status: <strong>{summary.status}</strong></div> : null}
              {summary.rationale ? <p>{summary.rationale}</p> : null}
              {summary.observation ? <p>{summary.observation}</p> : null}
            </div>
            <details className="rawStep">
              <summary>Raw API step payload</summary>
              <pre>{JSON.stringify(step, null, 2)}</pre>
            </details>
          </details>
          );
        })}
      </div>
    </div>
  );
}

function ReviewList({
  reviews,
  totalReviews,
  indexedReviewTextCount,
  visibleCount,
  onLoadMore
}: {
  reviews: Review[];
  totalReviews: number;
  indexedReviewTextCount: number;
  visibleCount: number;
  onLoadMore: () => void;
}) {
  if (reviews.length === 0) {
    return <p className="mutedText">No guest reviews available for this listing in the prepared dataset.</p>;
  }

  const visible = reviews.slice(0, visibleCount);
  const canLoadMore = visibleCount < reviews.length;

  return (
    <>
      <div className="reviewMetaLine">
        Showing {visible.length} of {reviews.length} preview reviews. The agent can search {indexedReviewTextCount} indexed review texts for this listing; the source listing reports {totalReviews} total reviews.
      </div>
      <div className="reviewGrid">
        {visible.map((review) => (
          <article className="reviewItem" key={review.id}>
            <div className="reviewHeader">
              <div className="reviewAvatar">
                <UserRound size={18} />
              </div>
              <div>
                <strong>Guest review</strong>
                <span>{review.date}</span>
              </div>
            </div>
            <p>{review.comments.length > 260 ? `${review.comments.slice(0, 260).trim()}...` : review.comments}</p>
          </article>
        ))}
      </div>
      {canLoadMore ? (
        <button className="loadMoreButton" type="button" onClick={onLoadMore}>
          Load more reviews
        </button>
      ) : null}
    </>
  );
}

function getDecision(step?: AgentStep): string | null {
  if (!step || typeof step.response !== "object" || step.response === null) {
    return null;
  }

  const response = step.response as { decision?: string };
  return response.decision ?? null;
}

function getEvidenceTopics(proposal: unknown): string[] {
  if (!proposal || typeof proposal !== "object") {
    return [];
  }

  const value = proposal as { evidence_topics?: unknown };
  if (!Array.isArray(value.evidence_topics)) {
    return [];
  }

  return value.evidence_topics.filter((topic): topic is string => typeof topic === "string");
}

function extractWhyLine(response: string): string {
  const match = response.match(/Why this improves the page:\s*([^\n]+)/i);
  if (match?.[1]) {
    return `Why this helps: ${match[1]}`;
  }

  if (/No action was taken/i.test(response)) {
    return "Why this helps: the agent avoided an unsupported edit instead of changing the page without strong evidence.";
  }

  if (/restored/i.test(response)) {
    return "Why this helps: the simulated page returned to the original dataset text after the manager rejected the edit.";
  }

  return "Why this helps: the agent kept the action within the allowed demo scope and explained the result.";
}

function summarizeTraceStep(step: AgentStep): TraceSummary {
  const response = isRecord(step.response) ? step.response : {};

  if (typeof response.next_action === "string") {
    return {
      title: labelFromSnake(response.next_action),
      action: response.next_action,
      rationale: stringValue(response.short_rationale),
      observation: stringValue(response.state_update)
    };
  }

  if (typeof response.in_scope === "boolean") {
    return {
      title: response.in_scope ? "Request is in scope" : "Request stopped before tools",
      status: response.in_scope ? "in scope" : "out of scope",
      rationale: stringValue(response.reason),
      observation: stringValue(response.token_safety)
    };
  }

  if (typeof response.listing_name === "string" && typeof response.status === "string") {
    return {
      title: `${response.listing_name}: ${labelFromSnake(response.status)}`,
      status: response.status,
      rationale: Array.isArray(response.selected_actions)
        ? `Selected actions: ${arrayOfStrings(response.selected_actions).join(" -> ")}.`
        : undefined,
      observation: stringValue(response.response)
    };
  }

  if (typeof response.decision === "string") {
    return {
      title: `Supervisor ${response.decision}`,
      decision: response.decision,
      rationale: stringValue(response.rationale),
      observation: summarizeGuardrails(response.guardrails)
    };
  }

  if (isRecord(response.page_update)) {
    return {
      title: response.page_update.status === "executed" ? "Executed approved page update" : "No page update executed",
      status: stringValue(response.page_update.status),
      observation: isRecord(response.audit_log)
        ? `Audit log recorded for ${stringValue(response.audit_log.listingName) ?? "the selected listing"}.`
        : "The simulated page state was handled according to the Supervisor decision."
    };
  }

  if (Array.isArray(response.recommendations)) {
    return {
      title: "Drafted manager recommendations",
      status: `${response.recommendations.length} recommendations`,
      rationale: "The request asked for fixable property or operations issues, so the agent produced manager-facing advice instead of editing the page.",
      observation: stringValue(response.editable_scope)
    };
  }

  if (isRecord(response.evidence_report)) {
    return {
      title: "Drafted evidence report",
      status: `${numberValue(response.evidence_report.matchingEvidenceCount) ?? 0} matching examples`,
      rationale: "The request asked for more evidence, so the agent reported review examples instead of editing the page.",
      observation: stringValue(response.editable_scope)
    };
  }

  if (typeof response.requested_listings === "number") {
    return {
      title: "Selected managed listing portfolio",
      status: `${response.requested_listings} listings`,
      rationale: stringValue(response.selection_rule),
      observation: stringValue(response.token_safety)
    };
  }

  if (isRecord(response.proposed_action)) {
    return {
      title: labelFromSnake(stringValue(response.proposed_action.action) ?? "Prepared page action"),
      action: stringValue(response.proposed_action.action),
      rationale: stringValue(response.proposed_action.reason),
      observation: `Target fields: ${arrayOfStrings(response.proposed_action.target_fields).join(", ") || "none"}.`
    };
  }

  if (typeof response.found === "boolean") {
    if (response.found && response.name_match === false) {
      return {
        title: "Listing name mismatch blocked",
        status: "blocked",
        rationale: stringValue(response.safety_note),
        observation: `Selected listing: ${stringValue(response.selected_listing_name) ?? "unknown"}. Prompt mentioned: ${stringValue(response.requested_listing_name) ?? "unknown"}.`
      };
    }

    return {
      title: response.found ? "Loaded selected listing" : "Listing not found",
      status: response.found ? "found" : "not found",
      observation: response.found
        ? `${stringValue(response.listing_name) ?? "Selected listing"} was loaded.`
        : stringValue(response.safety_note)
    };
  }

  if (Array.isArray(response.retrieved_reviews)) {
    const indexedCount = numberValue(response.indexed_review_texts_available) ?? numberValue(response.total_reviews_available);
    const retrievedCount = numberValue(response.retrieved_review_count);
    const source = stringValue(response.source);
    return {
      title: "Retrieved guest review evidence",
      status: `${response.retrieved_reviews.length} relevant reviews`,
      observation: `${retrievedCount ?? response.retrieved_reviews.length} reviews were retrieved from ${source ?? "Review RAG"} for this action. The full read-only index has ${indexedCount ?? "many"} review texts for this listing.`
    };
  }

  if (Array.isArray(response.nearby_places)) {
    return {
      title: "Retrieved Google Places context",
      status: `${response.nearby_places.length} nearby places`,
      observation: stringValue(response.context_rule)
    };
  }

  if (Array.isArray(response.signals)) {
    const topics = response.signals
      .filter(isRecord)
      .map((signal) => stringValue(signal.topic))
      .filter((topic): topic is string => Boolean(topic));
    return {
      title: "Detected guest signals",
      status: topics.join(", ") || "No strong signal",
      observation: summarizeValidation(response.validation)
    };
  }

  if (isRecord(response.current_claims)) {
    return {
      title: "Extracted editable page claims",
      observation: "The agent inspected the current simulated listing text before deciding whether an edit is justified."
    };
  }

  if (isRecord(response.audit_log)) {
    return {
      title: "Stopped without page edit",
      observation: "The agent wrote an audit log and left the simulated listing page unchanged."
    };
  }

  return {
    title: step.module,
    observation: "Observation recorded."
  };
}

function summarizeGuardrails(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.passed === true) {
    return "Runtime guardrails passed.";
  }

  const violations = arrayOfStrings(value.violations);
  return violations.length > 0 ? `Guardrails blocked: ${violations.join(", ")}.` : undefined;
}

function summarizeValidation(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const primaryEvidence = numberValue(value.strongest_primary_evidence_count);
  if (value.passed === true) {
    return `Evidence validation passed with ${primaryEvidence ?? "sufficient"} primary review signals.`;
  }

  return "Evidence validation did not justify an unsafe or unsupported edit.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function labelFromSnake(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function amenityIcon(amenity: string) {
  const normalized = amenity.toLowerCase();
  if (normalized.includes("wifi")) return <Wifi size={21} />;
  if (normalized.includes("tv")) return <Tv size={21} />;
  if (normalized.includes("washer") || normalized.includes("laundry")) return <WashingMachine size={21} />;
  if (normalized.includes("kitchen") || normalized.includes("oven") || normalized.includes("stove")) return <CookingPot size={21} />;
  if (normalized.includes("coffee")) return <Coffee size={21} />;
  if (normalized.includes("parking")) return <CircleParking size={21} />;
  if (normalized.includes("workspace") || normalized.includes("work")) return <BriefcaseBusiness size={21} />;
  if (normalized.includes("hair dryer")) return <Wind size={21} />;
  if (normalized.includes("pool")) return <Waves size={21} />;
  if (normalized.includes("gym")) return <Dumbbell size={21} />;
  if (normalized.includes("bath")) return <Bath size={21} />;
  if (normalized.includes("bed")) return <BedDouble size={21} />;
  if (normalized.includes("self check")) return <DoorOpen size={21} />;
  if (normalized.includes("guest")) return <Users size={21} />;
  return <Sparkles size={21} />;
}

function extractNearbyHighlights(description: string): string | null {
  const match = description.match(/Nearby highlights:\s*([^.\n]+(?:\.[^\n]*)?)/i);
  return match?.[0] ?? null;
}
