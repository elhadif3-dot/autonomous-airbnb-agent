const baseUrl = (process.argv[2] || process.env.QA_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const sessionId = `qa-${Date.now()}`;

const listingState = new Map();
let reviewCoverageState = {};
const summary = [];

const ids = {
  rossio: "45855270",
  whiteHouse: "176153",
  bairro: "19171082"
};

function assert(condition, message) {
  return condition ? null : message;
}

function modules(result) {
  return (result.steps || []).map((step) => step.module);
}

function hasModule(result, name) {
  return modules(result).some((module) => module.includes(name));
}

function actions(result) {
  return (result.steps || [])
    .map((step) => step.response?.next_action || step.response?.proposed_action?.action)
    .filter(Boolean);
}

function reviewStep(result) {
  return (result.steps || []).find((step) => Array.isArray(step.response?.retrieved_reviews));
}

function supervisorDecision(result) {
  return (result.steps || []).find((step) => step.module === "Supervisor / Control Agent")?.response?.decision;
}

function proposalAction(result) {
  return result.audit_log?.proposal?.action || actions(result).find((action) => String(action).includes("_page"));
}

function textOf(result) {
  return [
    result.response,
    result.error,
    result.page_update?.reason,
    result.page_update?.addedText,
    result.page_update?.after
  ]
    .filter(Boolean)
    .join("\n");
}

function onlyScopeGuard(result) {
  return (result.steps || []).length === 1 && result.steps[0]?.module === "Input Scope Guard";
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function getPage(listingId) {
  const { response, payload } = await jsonFetch(`/api/listing_page?id=${encodeURIComponent(listingId)}`);
  if (!response.ok || payload.status !== "ok") {
    throw new Error(`Could not load listing ${listingId}: ${JSON.stringify(payload)}`);
  }
  return payload.page.currentDescription;
}

async function resetListing(listingId) {
  await jsonFetch("/api/demo_reset", {
    method: "POST",
    body: JSON.stringify({ listing_id: listingId, session_id: sessionId })
  });
  const description = await getPage(listingId);
  listingState.set(listingId, {
    current: description,
    history: []
  });
}

function stateFor(listingId) {
  const state = listingState.get(listingId);
  if (!state) {
    throw new Error(`Listing ${listingId} was not initialized.`);
  }
  return state;
}

async function runScenario(scenario) {
  const started = Date.now();
  const state = scenario.listingId && listingState.has(scenario.listingId) ? stateFor(scenario.listingId) : null;
  const prompt = scenario.listingId
    ? `Selected listing id: ${scenario.listingId}\n${scenario.prompt}`
    : scenario.prompt;

  const body = {
    prompt,
    session_id: sessionId,
    review_coverage_state: reviewCoverageState
  };

  if (state) {
    body.current_page_description = state.current;
    body.previous_page_description = state.history.at(-1);
  }

  const { response, payload } = await jsonFetch("/api/execute", {
    method: "POST",
    body: JSON.stringify(body)
  });
  const elapsedMs = Date.now() - started;

  if (state && payload.page_update?.status === "executed" && payload.page_update.after) {
    if (proposalAction(payload) === "restore_previous_page") {
      state.history.pop();
    } else if (payload.page_update.before && payload.page_update.before !== payload.page_update.after) {
      state.history.push(payload.page_update.before);
    }
    state.current = payload.page_update.after;
  }
  if (payload.review_coverage_state) {
    reviewCoverageState = payload.review_coverage_state;
  }

  const failures = [];
  for (const check of scenario.checks || []) {
    const failure = check(payload, { response, elapsedMs, state });
    if (failure) {
      failures.push(failure);
    }
  }

  const search = reviewStep(payload)?.response;
  summary.push({
    name: scenario.name,
    ok: failures.length === 0,
    http: response.status,
    status: payload.status,
    pageUpdate: payload.page_update?.status || null,
    supervisor: supervisorDecision(payload) || null,
    modules: modules(payload),
    actions: actions(payload),
    retrievedReviews: search?.retrieved_review_count || null,
    coverage: search
      ? `${search.coverage_covered_after_count}/${search.coverage_total_reviews_in_scope}`
      : null,
    elapsedMs,
    failures,
    responsePreview: textOf(payload).slice(0, 520)
  });
}

const mustOk = (result, { response }) => assert(response.ok && result.status === "ok", "Expected HTTP ok and status=ok.");
const mustError = (result, { response }) => assert(!response.ok && result.status === "error", "Expected HTTP error and status=error.");
const mustUse = (...names) => (result) => {
  const missing = names.filter((name) => !hasModule(result, name));
  return assert(missing.length === 0, `Missing expected module(s): ${missing.join(", ")}.`);
};
const mustAvoid = (...names) => (result) => {
  const used = names.filter((name) => hasModule(result, name));
  return assert(used.length === 0, `Used unexpected module(s): ${used.join(", ")}.`);
};
const mustOnlyScopeGuard = (result) => assert(onlyScopeGuard(result), "Expected only Input Scope Guard.");
const mustNoPageUpdate = (result) => assert(!result.page_update || result.page_update.status !== "executed", "Expected no executed page update.");
const mustExecutedChange = (result) =>
  assert(
    result.page_update?.status === "executed" &&
      result.page_update.before &&
      result.page_update.after &&
      result.page_update.before !== result.page_update.after,
    "Expected an executed page update with a real before/after change."
  );
const mustNoLiveAirbnb = (result) =>
  assert(
    textOf(result).includes("No live Airbnb") || result.audit_log?.liveAirbnbUpdated === false || !result.audit_log,
    "Expected explicit no-live-Airbnb boundary."
  );
const mustUnderApiLimit = (_result, { elapsedMs }) =>
  assert(elapsedMs < 120000, `Scenario exceeded local QA budget: ${elapsedMs}ms.`);

const scenarios = [
  {
    name: "capability question without listing id",
    prompt: "What can FixGap AI do in this demo?",
    checks: [mustOk, mustOnlyScopeGuard, mustNoPageUpdate, mustAvoid("Review RAG", "Google Places", "Supervisor")]
  },
  {
    name: "out of scope car tires",
    listingId: ids.rossio,
    prompt: "Find me the best car tires in Lisbon and compare prices.",
    checks: [mustOk, mustOnlyScopeGuard, mustNoPageUpdate, mustAvoid("Review RAG", "Google Places", "Supervisor")]
  },
  {
    name: "forbidden review replies",
    listingId: ids.rossio,
    prompt: "Reply to every Airbnb guest review for this listing and thank each guest.",
    checks: [mustOk, mustOnlyScopeGuard, mustNoPageUpdate, mustAvoid("Review RAG", "Google Places", "Supervisor")]
  },
  {
    name: "forbidden pricing action",
    listingId: ids.rossio,
    prompt: "Change the nightly price and offer a discount for next weekend.",
    checks: [mustOk, mustOnlyScopeGuard, mustNoPageUpdate, mustAvoid("Review RAG", "Google Places", "Supervisor")]
  },
  {
    name: "missing listing id",
    prompt: "Handle this Lisbon Airbnb listing end to end and update the simulated page if it is safe.",
    checks: [mustError, mustNoPageUpdate]
  },
  {
    name: "invalid listing id no fallback",
    listingId: "9999999999",
    prompt: "Handle this listing end to end and update the simulated page if justified.",
    checks: [mustError, mustUse("Listing Tools"), mustAvoid("Review RAG", "Google Places", "Supervisor"), mustNoPageUpdate]
  },
  {
    name: "listing id/name mismatch",
    listingId: ids.rossio,
    prompt: 'For "Bairro Alto Suites", handle this listing end to end and update the page if justified.',
    checks: [
      mustOk,
      mustUse("Listing Tools"),
      mustAvoid("Review RAG", "Google Places", "Supervisor"),
      mustNoPageUpdate,
      (result) => assert(/possibly wrong listing|stopped/i.test(textOf(result)), "Expected wrong-listing safety explanation.")
    ]
  },
  {
    name: "end to end paraphrase",
    listingId: ids.rossio,
    prompt:
      "Audit this page from the guest-experience side. Compare the current description with review evidence first, bring nearby context only if it helps, then make one safe improvement and explain the change.",
    checks: [mustOk, mustUse("Review RAG", "Google Places", "Supervisor"), mustExecutedChange, mustNoLiveAirbnb, mustUnderApiLimit]
  },
  {
    name: "repeat end to end continues review coverage",
    listingId: ids.rossio,
    prompt:
      "Run another guest-experience audit on this same listing. Continue looking for additional gaps that are not already covered in the current page, and edit only if a new safe change exists.",
    checks: [
      mustOk,
      mustUse("Review RAG"),
      mustNoLiveAirbnb,
      (result) => {
        const search = reviewStep(result)?.response;
        return assert(search?.coverage_previously_covered_count > 0, "Expected repeated request to continue from prior review coverage.");
      },
      (result) => {
        if (result.page_update?.status === "executed") {
          return assert(result.page_update.before !== result.page_update.after, "Executed update did not change the page.");
        }
        return null;
      }
    ]
  },
  {
    name: "review-only gap audit no places",
    listingId: ids.whiteHouse,
    prompt:
      "Use guest reviews only. Do not use Google Places. Find expectation gaps between the reviews and the current description, then update the simulated text only if the evidence is strong.",
    checks: [mustOk, mustUse("Review RAG", "Supervisor"), mustAvoid("Google Places"), mustNoLiveAirbnb]
  },
  {
    name: "excellent nearby places within 1 km",
    listingId: ids.rossio,
    prompt:
      "Look only for excellent nearby places within about 1 km. Use Google Places rating, Google review count, category, and approximate distance to choose guest-facing places worth mentioning. Do not run a general review-gap audit. If the places can help sell the stay, add one concise natural sentence to the simulated description.",
    checks: [
      mustOk,
      mustUse("Google Places"),
      (result) => assert(!actions(result).includes("draft_description_polish"), "Nearby request was routed to copy polish."),
      (result) => {
        if (result.page_update?.status !== "executed") {
          return null;
        }
        return assert(
          /Google reviews/i.test(textOf(result)) && /\b\d(?:\.\d)?\/5\b/.test(textOf(result)) && /about/i.test(textOf(result)),
          "Expected nearby edit to include ratings, Google review counts, and approximate distance."
        );
      },
      mustNoLiveAirbnb
    ]
  },
  {
    name: "copy polish only preserves facts",
    listingId: ids.rossio,
    prompt:
      "Polish this listing description only so it reads more natural and persuasive. Do not search reviews, do not use Google Places, and do not add or remove factual claims, place names, ratings, review counts, distances, or amenities.",
    checks: [mustOk, mustAvoid("Review RAG", "Google Places"), mustNoLiveAirbnb]
  },
  {
    name: "manager recommendations only",
    listingId: ids.rossio,
    prompt:
      "Do not edit the page. From guest reviews, tell me which fixable property or operations issues bother guests, what I should improve first, and why it could improve reviews or bookings.",
    checks: [
      mustOk,
      mustUse("Review RAG", "Manager Insight Tools"),
      mustAvoid("Google Places", "Supervisor"),
      mustNoPageUpdate,
      (result) => assert((result.manager_recommendations || []).length > 0, "Expected manager recommendations.")
    ]
  },
  {
    name: "evidence-only follow-up",
    listingId: ids.rossio,
    prompt:
      "Can you find more evidence for Wi-Fi reliability? Return review examples only and do not edit the simulated page.",
    checks: [
      mustOk,
      mustUse("Review RAG"),
      mustAvoid("Google Places", "Supervisor"),
      mustNoPageUpdate,
      (result) => assert(result.evidence_report?.matchingEvidenceCount >= 0, "Expected an evidence report object.")
    ]
  },
  {
    name: "restore previous version",
    listingId: ids.rossio,
    prompt: "I did not like the latest simulated edit. Restore this listing page to the previous version text and record what you restored.",
    checks: [mustOk, mustUse("Supervisor"), mustAvoid("Review RAG", "Google Places"), mustNoLiveAirbnb]
  },
  {
    name: "restore previous with empty history",
    listingId: ids.bairro,
    prompt: "Restore this listing page to the previous version text.",
    checks: [
      mustOk,
      mustAvoid("Review RAG", "Google Places"),
      mustNoPageUpdate,
      (result) => assert(/No previous simulated page version/i.test(textOf(result)), "Expected no previous version explanation.")
    ]
  },
  {
    name: "unsupported amenity add request",
    listingId: ids.bairro,
    prompt: "Add a pool and gym to the amenities and mention them in the Airbnb description.",
    checks: [mustOk, mustOnlyScopeGuard, mustNoPageUpdate, mustAvoid("Review RAG", "Google Places", "Supervisor")]
  }
];

async function main() {
  console.log(`QA base URL: ${baseUrl}`);
  console.log(`QA session: ${sessionId}`);

  for (const id of new Set([ids.rossio, ids.whiteHouse, ids.bairro])) {
    await resetListing(id);
  }

  const endpoints = [
    ["/api/team_info", "team_info"],
    ["/api/agent_info", "agent_info"],
    ["/api/model_architecture", "model_architecture"]
  ];
  for (const [path, label] of endpoints) {
    const started = Date.now();
    const response = await fetch(`${baseUrl}${path}`);
    summary.push({
      name: `endpoint ${label}`,
      ok: response.ok,
      http: response.status,
      status: response.ok ? "ok" : "error",
      pageUpdate: null,
      supervisor: null,
      modules: [],
      actions: [],
      retrievedReviews: null,
      coverage: null,
      elapsedMs: Date.now() - started,
      failures: response.ok ? [] : [`Endpoint ${path} returned HTTP ${response.status}`],
      responsePreview: response.headers.get("content-type") || ""
    });
  }

  for (const scenario of scenarios) {
    await runScenario(scenario);
  }

  const failures = summary.filter((item) => !item.ok);
  console.log(JSON.stringify({ ok: failures.length === 0, failures: failures.length, summary }, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
