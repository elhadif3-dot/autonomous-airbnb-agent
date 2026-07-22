# Test Scenarios

These scenarios demonstrate different dynamically selected action traces.

For repeated local demos, reset the selected simulated page with the UI `Reset Page` button or `POST /api/demo_reset`.

## Nearby Positive Highlight

Prompt:

```text
Selected listing id: 1000628612178379202
Find positive nearby highlights that are missing from the listing page and add only evidence-backed text.
```

Expected behavior:

- Uses Listing Tools.
- Uses Review RAG.
- Uses Google Places Context because the task is about nearby highlights.
- Submits to Supervisor.
- Executes only if Airbnb reviews provide primary support and Google Places adds context.
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
Check this listing for gaps.
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
