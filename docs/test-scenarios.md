# Test Scenarios

These scenarios demonstrate different dynamically selected action traces.

For repeated local demos, reset the selected simulated page with the UI `Reset Page` button or `POST /api/demo_reset`.

## Nearby Positive Highlight

Prompt:

```text
Selected listing id: 45855270
Hi, I manage several Airbnb listings in Lisbon. Please handle this listing end to end: compare the current page with guest reviews and nearby context, decide what is safe to improve, update the simulated listing page, and tell me exactly what changed.
```

Expected behavior:

- Uses Listing Tools.
- Uses Review RAG.
- Uses Google Places Context because the task is about nearby highlights.
- Submits to Supervisor.
- Executes only if Airbnb reviews provide primary support and Google Places adds context.
- Writes an audit log.

## Undo Simulated Page Edit

Prompt:

```text
Selected listing id: 45855270
I did not like the simulated edit. Restore this listing page to the original dataset text and record what you restored.
```

Expected behavior:

- Uses Listing Tools.
- Chooses `restore_original_page`.
- Does not retrieve reviews or Google Places because the request is a controlled restore.
- Submits to Supervisor.
- Restores only the simulated page description from the original dataset row.
- Writes an audit log.

## Wi-Fi / Remote Work

Prompt:

```text
Selected listing id: 1000509524156083637
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

## Weak Evidence

Prompt:

```text
Selected listing id: 1000509524156083637
Change anything that could improve the listing.
```

Expected behavior:

- Starts with minimal listing and review evidence.
- Stops without editing if no strong editable gap is found.
