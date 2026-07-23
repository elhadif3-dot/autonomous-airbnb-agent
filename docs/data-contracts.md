# Data Contracts

This file defines the production runtime data shape. The CSV files remain seed/source files; when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured, the app reads structured runtime data and writes simulated page state/audits through Supabase.

## Supabase Tables

### `listings`

Structured property source derived from `lisbon_listings_final_with_pois.csv`.

Required columns:

- `id` text primary key
- `name` text
- `description` text
- `neighbourhood` text
- `latitude` double precision
- `longitude` double precision
- `property_type` text
- `room_type` text
- `accommodates` integer
- `bathrooms_text` text
- `bedrooms` numeric
- `beds` numeric
- `amenities` jsonb
- `price` text
- `review_score` numeric
- `location_score` numeric
- `value_score` numeric
- `number_of_reviews` integer
- `nearby_places_count` integer

### `simulated_listing_pages`

The editable demo page state. This table represents what would have been changed in a real property-management integration.

Required columns:

- `listing_id` text primary key references `listings(id)`
- `current_description` text
- `previous_description` text nullable
- `updated_at` timestamptz

### `audit_logs`

Every approved, revised, blocked, or stopped autonomous action.

Required columns:

- `id` uuid primary key
- `listing_id` text references `listings(id)`
- `manager_prompt` text
- `decision` text
- `selected_tools` jsonb
- `evidence_summary` jsonb
- `proposal` jsonb
- `page_update` jsonb
- `supervisor_rationale` text
- `executed_in_demo_environment` boolean
- `live_airbnb_updated` boolean default false
- `created_at` timestamptz

### `google_places`

Structured nearby context derived from `lisbon_google_places_filtered.csv`.

Required columns:

- `id` uuid primary key
- `place_name` text
- `category` text
- `rating` numeric
- `num_of_reviews` integer
- `reviews_content` text
- `latitude` double precision
- `longitude` double precision

## Pinecone Indexes

### `airbnb-reviews`

Primary RAG evidence source.

Vector text:

- One chunk per review, or grouped short review chunks by listing when reviews are very short.

Metadata:

- `listing_id`
- `review_id`
- `date`
- `source = "airbnb_review"`
- `topic_tags`

### `lisbon-places`

Environmental context only.

Vector text:

- `place_name`, `category`, and compressed `reviews_content`.

Metadata:

- `place_name`
- `category`
- `rating`
- `num_of_reviews`
- `lat`
- `long`
- `source = "google_places_context"`

## Retrieval Rules

- Retrieve Airbnb reviews first.
- Use Google Places only for location/environment context.
- Do not let Google Places alone justify a guest-experience correction.
- Send only top-k evidence snippets to the LLM.
- Keep `/api/execute` under Vercel's 300 second limit.
- Never fallback to another listing when a listing id is missing or invalid.
- Approved actions must update `simulated_listing_pages` and create an `audit_logs` row.

## Setup Files

- SQL schema: `supabase/schema.sql`
- Seed command: `npm run seed-supabase`
- Strict runtime flag: set `REQUIRE_SUPABASE_RUNTIME=true` after Supabase is seeded and configured in Vercel.
