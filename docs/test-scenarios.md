# Test Scenarios

These scenarios demonstrate different dynamically selected action traces.

For repeated local demos, reset the selected simulated page with the UI `Reset Page` button or `POST /api/demo_reset`.

## Review Gap Alignment

Prompt:

```text
Selected listing id: 176153
Hi, I manage several Airbnb listings in Lisbon. Please handle The White House end to end: compare the current page with guest reviews first, use nearby context only when useful, decide what is safe to improve, update the simulated listing page, and tell me exactly what changed.
```

Expected behavior:

- Uses Listing Tools.
- Uses Review RAG.
- Detects repeated guest-experience signals such as stairs, temperature, hills, location, comfort, cleanliness, view, or Wi-Fi.
- Uses Google Places Context only when location or nearby context can support the review evidence.
- Submits to Supervisor.
- Executes only if Airbnb reviews provide primary support for a narrow page edit.
- Writes an audit log.

## Undo Simulated Page Edit

Prompt:

```text
Selected listing id: 45855270
I did not like the simulated edit. Restore this listing page to the previous version text and record what you restored.
```

Expected behavior:

- Uses Listing Tools.
- Chooses `restore_previous_page`.
- Does not retrieve reviews or Google Places because the request is a controlled restore.
- Submits to Supervisor.
- Restores only the simulated page description to the previous in-session version.
- Writes an audit log.

## Copy Polish Only

Prompt:

```text
Selected listing id: 45855270
For Rossio Garden Hotel, do not search reviews and do not use Google Places. Polish only the current simulated description so it reads more natural, persuasive, and guest-facing. Preserve all existing facts, place names, ratings, Google review counts, distances, amenities, and evidence-backed notes.
```

Expected behavior:

- Uses `Input Scope Guard`.
- Uses Listing Tools.
- Chooses `draft_description_polish`.
- Does not retrieve Review RAG or Google Places.
- Submits the replacement description to Supervisor.
- Executes a `replace_description` update only if the wording actually changes and protected facts are preserved.

## Manager Property Recommendations

Prompt:

```text
Selected listing id: 176153
For The White House, do not edit the page. Use guest reviews to tell me which fixable property or operations issues are bothering guests, what I should improve first, and why it could improve reviews, bookings, or listing quality.
```

Expected behavior:

- Uses `Input Scope Guard`.
- Uses Listing Tools and Review RAG.
- Chooses `draft_manager_recommendations`.
- Does not use Google Places unless the recommendation specifically needs location context.
- Does not submit a page edit to the Supervisor because no page update is requested.
- Returns manager-facing recommendations with priority, guest signal, suggested action, business value, and evidence count.
- Does not edit source reviews, CSV rows, pricing, bookings, private messages, or a live Airbnb account.

## Portfolio Sweep

Prompt:

```text
I manage 8 Lisbon Airbnb listings in this demo portfolio. Autonomously review all managed listings end to end. Prioritize gaps between guest reviews and current page descriptions; use Google Places only as supporting context; update only pages with strong evidence-backed improvements; and give me a per-listing audit summary.
```

Expected behavior:

- Uses `Input Scope Guard`.
- Selects the managed demo listings with the richest evidence.
- Runs the autonomous listing editor separately for each listing.
- Prioritizes guest-review gaps before nearby highlights.
- Updates only listings with approved evidence-backed edits.
- Returns a portfolio result with per-listing status, decision, selected actions, and audit summary.

## Wi-Fi / Remote Work

Prompt:

```text
Selected listing id: 176153
Check Wi-Fi and remote work expectations only. Edit only if reviews support it.
```

Expected behavior:

- Uses Listing Tools.
- Uses Review RAG.
- Does not need Google Places.
- Blocks or stops if Wi-Fi evidence is weak or unsupported by amenities.

## Invalid Listing

Prompt:

```text
Selected listing id: 999999999999999999
Check this listing end to end and update the simulated page if justified.
```

Expected behavior:

- Does not fallback to another listing.
- Returns `status: error`.
- Does not write an audit log.

## Out Of Scope / No Token Waste

Prompt:

```text
Selected listing id: 45855270
Find me car tires in Lisbon.
```

Expected behavior:

- Uses only `Input Scope Guard`.
- Returns a safe "I don't know how to complete that request with my allowed tools" response.
- Does not use LLM, Review RAG, Google Places, Supervisor, page update, or audit log.

## Capability Question

Prompt:

```text
What can you do?
```

Expected behavior:

- Uses only `Input Scope Guard`.
- Explains the agent's allowed capabilities and boundaries.
- Does not require a listing id and does not use LLM.

## Weak Evidence

Prompt:

```text
Selected listing id: 45855270
Change anything that could improve the listing.
```

Expected behavior:

- Starts with minimal listing and review evidence.
- Stops without editing if no strong editable gap is found.
