# Autonomous Lisbon Airbnb Listing Editor

Demo implementation for an autonomous AI agent that helps a Lisbon short-term-rental manager keep simulated Airbnb listing pages aligned with real guest experience.

The project uses prepared offline data only:

- `lisbon_listings_final_with_pois.csv` as structured listing data
- `lisbon_reviews_final_with_pois.csv` as the main guest-review evidence source
- `lisbon_google_places_filtered.csv` as nearby environmental context

No live Airbnb account is accessed, no scraping is performed, and all page updates are applied only inside the demo environment.
The listing page initially renders from the prepared Airbnb dataset. Agent edits are session-level simulated page updates; refreshing/re-entering the app starts again from the dataset state.
The UI exposes the full prepared listing catalog for selection. The "all managed listings" demo action intentionally runs on an evidence-rich manager portfolio so the end-to-end trace stays inspectable and fast.

Live LLM calls are disabled by default. The code runs in mock mode unless token usage is explicitly approved and enabled.
Every request first passes a deterministic scope guard. Out-of-scope requests stop before LLM, Review RAG, Google Places, or page-edit tools are used.

## Architecture

The agent follows a ReAct-style loop:

`Reason -> Choose Tool -> Observe -> Update State -> Replan or Stop`

Actual page edits are executed only after `Supervisor / Control Agent` approval.
Approved edits update the simulated listing page state and create an audit-log entry.
Manager prompts can also ask the agent to restore the simulated page to the original dataset text; that restore path uses a different action trace and still requires Supervisor approval.
Portfolio prompts can ask the agent to review all managed demo listings. The runtime selects the evidence-rich manager portfolio, runs each listing independently, prioritizes guest-review gaps before nearby highlights, updates only approved simulated pages, and returns a per-listing audit summary.
Manager insight prompts can ask what fixable property or operations issues guests mention. That action returns recommendations only; it does not edit the listing page and does not require live Airbnb access.

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

## Pinecone Setup

Pinecone is used as the vector DB for Airbnb review evidence when credentials are configured.
Without Pinecone credentials, the app falls back to the prepared CSV data so the demo remains usable.

```bash
npm run setup-pinecone
npm run setup-pinecone -- --create
npm run ingest-pinecone -- --limit 200 --confirm-paid
npm run pinecone-stats
```

Use a small `--limit` first. Remove the limit only after confirming the index, retrieval quality, and budget.
The ingestion script calls the LLMod embedding model and therefore requires `--confirm-paid`.

Required Pinecone/embedding environment variables:

```bash
LLMOD_API_KEY=...
LLMOD_BASE_URL=...
LLMOD_EMBEDDING_MODEL=MB5R2CF-azure/text-embedding-3-small
PINECONE_API_KEY=...
PINECONE_REVIEW_INDEX=airbnb-reviews
PINECONE_REVIEW_NAMESPACE=airbnb-reviews
```

## Vercel Deployment

The project is Vercel-ready. Add these environment variables in Vercel before production deployment:

```bash
LLMOD_API_KEY
LLMOD_BASE_URL
LLMOD_TEXT_MODEL
LLMOD_EMBEDDING_MODEL
LLM_MODE
LLM_LIVE_MODULES
LLM_MAX_TOKENS
PINECONE_API_KEY
PINECONE_REVIEW_INDEX
PINECONE_REVIEW_NAMESPACE
TEAM_STUDENT_1_NAME
TEAM_STUDENT_1_EMAIL
TEAM_STUDENT_2_NAME
TEAM_STUDENT_2_EMAIL
TEAM_STUDENT_3_NAME
TEAM_STUDENT_3_EMAIL
```

Deploy with GitHub import in Vercel, or from the CLI after login:

```bash
npx vercel
npx vercel --prod
```

After deployment, test the required endpoints with the Python smoke tester:

```bash
python python/api_smoke_test.py https://YOUR-VERCEL-URL
```

## Token Usage

The project is currently LLM-ready but runs in `LLM_MODE=mock`.
No LLMod.ai calls are made unless `LLM_MODE=live` is explicitly enabled and the project owner approves token usage.
Use `LLM_LIVE_MODULES=agent,supervisor` to enable both live decision modules, or restrict this list during testing to reduce spend.
For low-cost validation, start with `LLM_LIVE_MODULES=agent` and a restore prompt before running a full evidence-retrieval edit.
