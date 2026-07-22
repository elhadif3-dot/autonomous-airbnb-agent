# Autonomous Lisbon Airbnb Listing Editor

Demo implementation for an autonomous AI agent that helps a Lisbon short-term-rental manager keep simulated Airbnb listing pages aligned with real guest experience.

The project uses prepared offline data only:

- `lisbon_listings_final_with_pois.csv` as structured listing data
- `lisbon_reviews_final_with_pois.csv` as the main guest-review evidence source
- `lisbon_google_places_filtered.csv` as nearby environmental context

No live Airbnb account is accessed, no scraping is performed, and all page updates are applied only inside the demo environment.

Live LLM calls are disabled by default. The code runs in mock mode unless token usage is explicitly approved and enabled.

## Architecture

The agent follows a ReAct-style loop:

`Reason -> Choose Tool -> Observe -> Update State -> Replan or Stop`

Actual page edits are executed only after `Supervisor / Control Agent` approval.
Approved edits update the simulated listing page state and create an audit-log entry.

## Required API

- `GET /api/team_info`
- `GET /api/agent_info`
- `GET /api/model_architecture`
- `POST /api/execute`

Additional demo inspection endpoints:

- `GET /api/listing_page?id=<listing_id>`
- `GET /api/audit_logs?listing_id=<listing_id>`
- `POST /api/demo_reset`

`POST /api/execute` returns the required project schema. The field is named `steps`
because the project API requires it, but conceptually it is the agent action/tool trace:

```json
{
  "status": "ok",
  "error": null,
  "response": "...",
  "steps": []
}
```

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Token Usage

The project is currently LLM-ready but runs in `LLM_MODE=mock`.
No LLMod.ai calls are made unless `LLM_MODE=live` is explicitly enabled and the project owner approves token usage.
