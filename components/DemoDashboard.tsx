"use client";

import { useMemo, useState } from "react";
import type { AgentStep, ExecuteResponse, Listing } from "@/lib/types";

type Props = {
  listings: Listing[];
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
    setIsRunning(false);
  }

  if (!selectedListing) {
    return <main className="main">No listings available.</main>;
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">AL</div>
          <h1>Autonomous Lisbon Airbnb Listing Editor</h1>
          <p>Demo property-management environment</p>
        </div>

        <div className="listingList" aria-label="Managed listings">
          {listings.map((listing) => (
            <button
              key={listing.id}
              className="listingButton"
              type="button"
              aria-pressed={listing.id === selectedListing.id}
              onClick={() => setSelectedId(listing.id)}
            >
              <strong>{listing.name}</strong>
              <span>
                {listing.neighbourhood} · {listing.numberOfReviews} reviews
              </span>
            </button>
          ))}
        </div>

        <p className="finePrint">Simulated page updates only. No live Airbnb account is accessed.</p>
      </aside>

      <main className="main">
        <div className="topBar">
          <h2>Property Manager Console</h2>
          <div className="statusPill">ReAct Agent · Supervisor Controlled</div>
        </div>

        <div className="workspaceGrid">
          <section className="panel" aria-label="Simulated listing page">
            <div className="listingHero">
              <h3>{selectedListing.name}</h3>
              <p>{selectedListing.neighbourhood}, Lisbon · {selectedListing.propertyType}</p>
            </div>

            <div className="details">
              <div className="metrics">
                <Metric label="Rating" value={selectedListing.reviewScore?.toFixed(2) ?? "N/A"} />
                <Metric label="Location" value={selectedListing.locationScore?.toFixed(2) ?? "N/A"} />
                <Metric label="Guests" value={String(selectedListing.accommodates)} />
                <Metric label="POIs" value={String(selectedListing.nearbyPlacesCount)} />
              </div>

              <div className="description">{selectedListing.description}</div>

              <div className="chips">
                {selectedListing.amenities.slice(0, 8).map((amenity) => (
                  <span className="chip" key={amenity}>
                    {amenity}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="panel" aria-label="Agent runner">
            <div className="panelHeader">
              <h3>Agent Task</h3>
              <small>Listing ID {selectedListing.id}</small>
            </div>

            <div className="agentPanel">
              <textarea
                className="promptBox"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                aria-label="Agent prompt"
              />

              <div className="actions">
                <button className="primaryButton" type="button" onClick={runAgent} disabled={isRunning}>
                  {isRunning ? "Running..." : "Run Agent"}
                </button>
                <button
                  className="ghostButton"
                  type="button"
                  onClick={() => setPrompt(samplePrompts[(samplePrompts.indexOf(prompt) + 1) % samplePrompts.length] ?? samplePrompts[0])}
                >
                  Swap Prompt
                </button>
              </div>

              {!result ? (
                <div className="emptyState">
                  The Action Trace will show selected tools, retrieved evidence, Supervisor decision, and simulated audit result.
                </div>
              ) : (
                <AgentResult result={result} />
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

function getDecision(step?: AgentStep): string | null {
  if (!step || typeof step.response !== "object" || step.response === null) {
    return null;
  }

  const response = step.response as { decision?: string };
  return response.decision ?? null;
}
