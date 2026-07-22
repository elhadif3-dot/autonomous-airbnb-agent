# Deployment Checklist

## Required By Project

- Vercel deployment URL.
- GitHub repository URL.
- Required API endpoints:
  - `GET /api/team_info`
  - `GET /api/agent_info`
  - `GET /api/model_architecture`
  - `POST /api/execute`
- Pinecone vector DB for review evidence.
- LLMod.ai key for live LLM/embedding calls.

## Local Validation

```bash
npm install
npm run build
```

## Pinecone

Add these to `.env.local`:

```bash
PINECONE_API_KEY=...
PINECONE_REVIEW_INDEX=airbnb-reviews
PINECONE_REVIEW_NAMESPACE=airbnb-reviews
LLMOD_API_KEY=...
LLMOD_BASE_URL=...
LLMOD_EMBEDDING_MODEL=MB5R2CF-azure/text-embedding-3-small
```

Then:

```bash
npm run setup-pinecone
npm run setup-pinecone -- --create
npm run ingest-pinecone -- --limit 200 --confirm-paid
npm run pinecone-stats
```

Only remove `--limit` after the small ingestion looks correct.

## Vercel

Add the same environment variables in the Vercel project settings.

Recommended production values:

```bash
LLM_MODE=live
LLM_LIVE_MODULES=agent,supervisor
LLM_MAX_TOKENS=450
PINECONE_REVIEW_INDEX=airbnb-reviews
PINECONE_REVIEW_NAMESPACE=airbnb-reviews
```

Deploy:

```bash
npx vercel
npx vercel --prod
```

After deployment, test:

```bash
curl https://YOUR-VERCEL-URL/api/team_info
curl https://YOUR-VERCEL-URL/api/agent_info
curl https://YOUR-VERCEL-URL/api/model_architecture --output architecture.png
curl -X POST https://YOUR-VERCEL-URL/api/execute \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"Selected listing id: 176153\nHandle this listing end to end and explain the update.\"}"
```
