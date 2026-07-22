"use client";

import { useMemo, useState } from "react";
import {
  Bath,
  BedDouble,
  BriefcaseBusiness,
  CalendarDays,
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

type DisplayPlace = {
  placeName: string;
  category: string;
  rating: number | null;
  distanceKm?: number;
};

type DemoListing = Listing & {
  nearbyPlaces: DisplayPlace[];
  recentReviews: Review[];
};

type Props = {
  listings: DemoListing[];
};

const samplePrompts = [
  "Check this listing for gaps between guest reviews and the current page. If there is a justified edit, update the simulated page.",
  "Find positive nearby highlights that are missing from the listing page and add only evidence-backed text.",
  "Review whether the listing overpromises quietness or location convenience. Edit only if the evidence is strong."
];

export function DemoDashboard({ listings }: Props) {
  const [selectedId, setSelectedId] = useState(listings[0]?.id ?? "");
  const [prompt, setPrompt] = useState(samplePrompts[0]);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [simulatedDescriptions, setSimulatedDescriptions] = useState<Record<string, string>>({});

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

    const response = await fetch("/api/demo_reset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ listing_id: selectedListing.id })
    });
    const payload = (await response.json()) as { page?: { currentDescription: string } };
    setSimulatedDescriptions((current) => ({
      ...current,
      [selectedListing.id]: payload.page?.currentDescription ?? selectedListing.description
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
                  {selectedListing.accommodates} guests · {selectedListing.bedrooms ?? "N/A"} bedrooms ·{" "}
                  {selectedListing.beds ?? "N/A"} beds · {selectedListing.bathroomsText}
                </p>
              </div>
              <div className="hostAvatar">
                <UserRound size={24} />
              </div>
            </section>

            <section className="trustStrip">
              <TrustItem icon={<Medal size={24} />} title="Guest experience signals" text={`${selectedListing.numberOfReviews} Airbnb reviews`} />
              <TrustItem icon={<MapPin size={24} />} title="Location context" text={`${selectedListing.nearbyPlacesCount} nearby places in dataset`} />
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
                  <h2>Nearby places from the dataset</h2>
                  <p>Used as environmental context. Guest reviews remain the main evidence source.</p>
                </div>
                <Sparkles size={22} />
              </div>
              <NearbyPlaces places={selectedListing.nearbyPlaces} />
            </section>

            <section className="listingSection">
              <div className="sectionHeaderRow">
                <div>
                  <h2>Guest reviews</h2>
                  <p>Read-only source evidence. The agent can search reviews, but cannot edit them.</p>
                </div>
                <Star size={22} />
              </div>
              <ReviewList reviews={selectedListing.recentReviews} />
            </section>
          </article>

          <aside className="sideRail">
            <ReservationCard listing={selectedListing} />
            <AgentCard
              prompt={prompt}
              setPrompt={setPrompt}
              runAgent={runAgent}
              resetPage={resetPage}
              isRunning={isRunning}
              result={result}
            />
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
        <span>Listing demo</span>
        <button type="button" aria-label="Search">
          <Search size={17} />
        </button>
      </div>
      <div className="managerBadge">Property manager demo</div>
    </header>
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

function NearbyPlaces({ places }: { places: DisplayPlace[] }) {
  if (places.length === 0) {
    return <p className="mutedText">No nearby places available for this listing in the prepared dataset.</p>;
  }

  return (
    <div className="nearbyList">
      {places.slice(0, 6).map((place) => (
        <div className="nearbyItem" key={`${place.placeName}-${place.distanceKm}`}>
          <div className="nearbyIcon">
            <MapPin size={18} />
          </div>
          <div>
            <strong>{place.placeName}</strong>
            <span>
              {place.category} · {place.rating ?? "N/A"} rating · {place.distanceKm?.toFixed(1)} km
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EditableHighlights({ description }: { description: string }) {
  const highlights = extractNearbyHighlights(description);

  return (
    <div className="editableHighlightBlock">
      <div>
        <Sparkles size={20} />
        <strong>Curated nearby highlights on page</strong>
      </div>
      <p>{highlights ?? "No curated nearby highlights have been added to the simulated listing page yet."}</p>
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

function AgentCard({
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
    <section className="agentCard">
      <div className="agentCardHeader">
        <div>
          <span className="agentEyebrow">Autonomous Listing Editor</span>
          <h2>Improve this page with evidence</h2>
        </div>
        <MessageSquareText size={24} />
      </div>

      <textarea
        className="promptBox"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        aria-label="Agent prompt"
      />

      <div className="scopeBox">
        <div>
          <strong>Editable in demo</strong>
          <span>Description, guest expectation notes, nearby highlights text</span>
        </div>
        <div>
          <strong>Read-only sources</strong>
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

function AgentResult({ result }: { result: ExecuteResponse }) {
  const supervisorStep = result.steps.find((step) => step.module === "Supervisor / Control Agent");
  const decision = getDecision(supervisorStep);

  return (
    <div className="result">
      <div className="responseBox">
        <h4>Final Response</h4>
        {decision ? <span className={`decision ${decision.toLowerCase()}`}>{decision}</span> : null}
        <p>{result.response ?? result.error}</p>
      </div>

      {result.page_update ? (
        <div className="auditBox">
          <h4>Simulated Page Update</h4>
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
          <h4>Audit Log</h4>
          <p>
            {result.audit_log.createdAt} · {result.audit_log.decision} · liveAirbnbUpdated=
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

function ReviewList({ reviews }: { reviews: Review[] }) {
  if (reviews.length === 0) {
    return <p className="mutedText">No guest reviews available for this listing in the prepared dataset.</p>;
  }

  return (
    <div className="reviewGrid">
      {reviews.map((review) => (
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
