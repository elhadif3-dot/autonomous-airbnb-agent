# Strict Submission Test Scenarios

These scenarios validate the public submission contract. They intentionally treat `/api/execute.steps` as LLM calls only.

## Scope Guard

Prompt:

```text
Selected listing id: 45855270
Find me car tires in Lisbon.
```

Expected:

- `status: "ok"`
- safe refusal in `response`
- `steps: []`
- no Review RAG, Google Places, Supervisor, page update, or audit write

## Prompt-Only Execute

Prompt:

```text
Selected listing id: 176153
Handle this Lisbon Airbnb listing end to end and explain what changed.
```

Expected:

- request body contains only `prompt`
- `/api/execute` returns exactly `status`, `error`, `response`, `steps`
- final `response` explains what happened
- simulated page state is read from `/api/listing_page`
- audit data is read from `/api/audit_logs`

## Live LLM Step Shape

When `LLM_MODE=live` is enabled later, every step must have only:

```json
{
  "module": "Autonomous Listing Editor Agent",
  "prompt": {
    "system_prompt": "...",
    "user_prompt": "..."
  },
  "response": {}
}
```

Allowed LLM step modules:

- `Autonomous Listing Editor Agent`
- `Supervisor / Control Agent`

Deterministic operations must not appear as steps.
