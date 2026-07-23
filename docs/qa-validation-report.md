# QA Validation Report

Last local run: 2026-07-23

Command:

```bash
npm run qa:agent -- http://127.0.0.1:3000
```

Result: 20/20 scenarios passed.

## Coverage

- Required endpoints:
  - `GET /api/team_info`
  - `GET /api/agent_info`
  - `GET /api/model_architecture`
  - `POST /api/execute`
- In-scope autonomous listing edits:
  - End-to-end guest-experience alignment.
  - Review-only gap audit without Google Places.
  - Excellent nearby-place request using Google ratings, review counts, category, and approximate distance.
  - Copy polish without Review RAG or Google Places.
- Follow-up behavior:
  - Repeated end-to-end requests continue review coverage for the same audit scope.
  - Previous-version restore returns one in-session version back.
  - Empty previous-version restore stops without changing the page.
- Manager-facing non-edit tools:
  - Fixable property and operations recommendations from guest reviews.
  - Evidence-only follow-up report with review examples and no page edit.
- Safety and scope:
  - Out-of-scope car/tires request stops at Input Scope Guard.
  - Review-reply request stops at Input Scope Guard.
  - Pricing/discount action stops at Input Scope Guard.
  - Unsupported amenity addition stops at Input Scope Guard.
  - Missing listing id returns a clear error.
  - Invalid listing id does not fallback to another listing.
  - Listing id/name mismatch stops before retrieval or editing.

## Fixes Made During QA

- Added a reusable QA runner: `scripts/qa-agent.mjs`.
- Added `npm run qa:agent`.
- Strengthened `Input Scope Guard` for forbidden actions:
  - live Airbnb/account access
  - pricing and availability
  - bookings/reservations
  - private messages
  - review replies or review editing
  - unsupported amenity claims
- Updated capability response to recognize the product name `FixGap AI`.
- Fixed `stop_without_action` flow so the agent stops cleanly instead of submitting a non-edit to Supervisor.
- Canonicalized broad review-alignment coverage keys so paraphrased follow-up requests continue through additional review windows.
- Added serialized `review_coverage_state` round-tripping through `/api/execute`, the UI, and the QA runner so repeated review audits continue correctly on Vercel serverless deployments.
- Refined guardrail validation so existing pricing language copied from the original dataset does not block safe description rewrites, while new pricing actions remain blocked.

## Requirement Check

- Vercel deployment: configured.
- `/api/execute` max duration: `vercel.json` sets 300 seconds.
- Pinecone: active review index verified with `npm run pinecone-stats`.
- LLMod.ai: production environment variables are configured in Vercel.
- GUI: root page includes textarea, Run Agent button, final response, page result, audit log, and action trace.
- Supabase: schema is documented in `docs/data-contracts.md`, but Supabase credentials are not configured in the current deployment. Structured listing and Google Places data currently load from prepared CSV files; Pinecone is used for review vector retrieval.
