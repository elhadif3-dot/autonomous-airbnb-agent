# QA Validation Report

Last strict local run: 2026-07-23

Command:

```bash
LLM_MODE=mock DISABLE_PINECONE_RAG=true REQUIRE_PINECONE_RAG=false REQUIRE_SUPABASE_RUNTIME=false npm run qa:agent -- http://127.0.0.1:3100
```

Result: strict submission QA passed.

## What The Strict QA Checks

- `GET /api/team_info`
  - HTTP 200.
  - Exact top-level keys: `group_batch_order_number`, `team_name`, `students`.
  - `Batch3_08`.
  - Full student names.
- `GET /api/agent_info`
  - HTTP 200.
  - Exact top-level keys: `description`, `purpose`, `prompt_template`, `prompt_examples`.
  - Prompt examples contain only LLM-call steps.
- `GET /api/model_architecture`
  - HTTP 200.
  - `Content-Type: image/png`.
  - Valid PNG magic bytes.
- `POST /api/execute`
  - Works with `{ "prompt": "..." }` only.
  - Success and error responses contain exactly `status`, `error`, `response`, `steps`.
  - Out-of-scope deterministic guard returns `steps: []`.
  - Every returned step, when Live LLM is enabled later, must contain only `module`, `prompt`, `response`.
  - Every step prompt must contain only `system_prompt`, `user_prompt`.
  - Step modules are limited to `Autonomous Listing Editor Agent` and `Supervisor / Control Agent`.
- Runtime state endpoints:
  - `/api/listing_page` returns simulated page state.
  - `/api/audit_logs` returns audit records.

## Important Runtime Modes

- No LLMod.ai calls were used in this strict mock QA run.
- No embedding calls were used in this strict mock QA run because `DISABLE_PINECONE_RAG=true` was set for the local validation server.
- For strict production RAG validation, configure Pinecone and set `REQUIRE_PINECONE_RAG=true`.
- For strict Supabase validation, run `supabase/schema.sql`, seed with `npm run seed-supabase`, configure Supabase env vars in Vercel, and set `REQUIRE_SUPABASE_RUNTIME=true`.

## Remaining Submission Gate

Supabase credentials are still required before enabling strict Supabase runtime in Vercel:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REQUIRE_SUPABASE_RUNTIME=true`
