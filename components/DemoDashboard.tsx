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
};

type Props = {
  listings: DemoListing[];
};

const promptExamples = [
  {
    label: "Add nearby highlights",
    hint: "Use reviews + Lisbon context",
    prompt: "Find positive nearby highlights that are missing from the listing page and add only evidence-backed text."
  },
  {
    label: "Find listing gaps",
    hint: "Compare page vs reviews",
    prompt: "Check this listing for gaps between guest reviews and the current page. If there is a justified edit, update the simulated page."
  },
  {
    label: "Check quiet claims",
    hint: "Edit only with strong evidence",
    prompt: "Review whether the listing overpromises quietness or location convenience. Edit only if the evidence is strong."
  }
];

export function DemoDashboard({ listings }: Props) {
  const [selectedId, setSelectedId] = useState(listings[0]?.id ?? "");
  const [prompt, setPrompt] = useState(promptExamples[0].prompt);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [simulatedDescriptions, setSimulatedDescriptions] = useState<Record<string, string>>({});
  const [visibleReviews, setVisibleReviews] = useState<Record<string, number>>({});

  const selectedListing = useMemo(
    () => listings.find((listing) => listing.id === selectedId) ?? listings[0],
    [listings, selectedId]
  );

  async function runAgent() {
    if (!selectedListing) {
      return;
    }

    setIsRunning(true);
    setResult(null);

    const response = await fetch("/api/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: `Selected listing id: ${selectedListing.id}\n${prompt}`
      })
    });

    const payload = (await response.json()) as ExecuteResponse;
    setResult(payload);
    if (payload.page_update?.status === "executed" && payload.page_update.after) {
      setSimulatedDescriptions((current) => ({
        ...current,
        [payload.page_update!.listingId]: payload.page_update!.after!
      }));
    }
    setIsRunning(false);
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
    return <main className="airbnbPage">No listings available.</main>;
  }

  const currentDescription = simulatedDescriptions[selectedListing.id] ?? selectedListing.description;

  return (
    <div className="airbnbPage">
      <Header
        listings={listings}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setResult(null);
        }}
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
                    {selectedListing.numberOfReviews} total reviews in the dataset. Reviews are read-only evidence and cannot be edited by the agent.
                  </p>
                </div>
                <Star size={22} />
              </div>
              <ReviewList
                reviews={selectedListing.recentReviews}
                totalReviews={selectedListing.numberOfReviews}
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
            />
            <ReservationCard listing={selectedListing} />
          </aside>
        </div>
      </main>
    </div>
  );
}

function Header({
  listings,
  selectedId,
  onSelect
}: {
  listings: DemoListing[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <header className="airbnbHeader">
      <div className="airbnbLogo">
        <Home size={26} />
        <span>airbnb</span>
      </div>
      <div className="searchPill">
        <select value={selectedId} onChange={(event) => onSelect(event.target.value)} aria-label="Choose managed listing">
          {listings.map((listing) => (
            <option key={listing.id} value={listing.id}>
              {listing.name}
            </option>
          ))}
        </select>
        <span>Lisbon</span>
        <span>Managed listing</span>
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
  result
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  runAgent: () => void;
  resetPage: () => void;
  isRunning: boolean;
  result: ExecuteResponse | null;
}) {
  return (
    <section className="agentDock">
      <div className="agentDockIntro">
        <div className="agentIconBubble">
          <MessageSquareText size={20} />
        </div>
        <div>
          <span className="agentEyebrow">Autonomous Listing Editor</span>
          <h2>Improve this listing page</h2>
          <p>Ask for an evidence-backed page edit. The source data stays read-only.</p>
        </div>
      </div>

      <div className="promptExamples">
        {promptExamples.map((example) => (
          <button type="button" key={example.label} onClick={() => setPrompt(example.prompt)}>
            <strong>{example.label}</strong>
            <span>{example.hint}</span>
          </button>
        ))}
      </div>

      <label className="promptLabel" htmlFor="agent-prompt">
        Open request
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
          Action Trace will show selected tools, observations, Supervisor decision, page update, and audit log.
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

  return (
    <div className="result">
      <div className="responseBox">
        <h4>Agent response</h4>
        {decision ? <span className={`decision ${decision.toLowerCase()}`}>{decision}</span> : null}
        <p>{result.response ?? result.error}</p>
      </div>

      {result.page_update ? (
        <div className="auditBox">
          <h4>What changed on the simulated page</h4>
          <p>Status: {result.page_update.status}</p>
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
        {result.steps.map((step, index) => (
          <details className="stepBox" key={`${step.module}-${index}`} open={index === 0 || step.module.includes("Supervisor")}>
            <summary>
              Action {index + 1}: {step.module}
            </summary>
            <pre>{JSON.stringify(step, null, 2)}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}

function ReviewList({
  reviews,
  totalReviews,
  visibleCount,
  onLoadMore
}: {
  reviews: Review[];
  totalReviews: number;
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
        Showing {visible.length} of {totalReviews} reviews. More reviews are available to the agent through retrieval.
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
