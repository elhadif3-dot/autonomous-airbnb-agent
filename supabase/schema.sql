create table if not exists listings (
  id text primary key,
  name text not null,
  description text not null,
  neighbourhood text,
  latitude double precision,
  longitude double precision,
  property_type text,
  room_type text,
  accommodates integer,
  bathrooms_text text,
  bedrooms numeric,
  beds numeric,
  amenities jsonb default '[]'::jsonb,
  price text,
  review_score numeric,
  location_score numeric,
  value_score numeric,
  number_of_reviews integer default 0,
  nearby_places_count integer default 0
);

create table if not exists simulated_listing_pages (
  listing_id text primary key references listings(id) on delete cascade,
  current_description text not null,
  previous_description text,
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key,
  listing_id text references listings(id) on delete cascade,
  listing_name text,
  manager_prompt text not null,
  decision text not null,
  selected_tools jsonb default '[]'::jsonb,
  evidence_summary jsonb,
  proposal jsonb,
  page_update jsonb,
  supervisor_rationale text,
  executed_in_demo_environment boolean not null default false,
  live_airbnb_updated boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists google_places (
  id uuid primary key default gen_random_uuid(),
  place_name text not null,
  category text,
  rating numeric,
  num_of_reviews integer default 0,
  reviews_content text,
  latitude double precision,
  longitude double precision
);

create index if not exists audit_logs_listing_created_idx
  on audit_logs (listing_id, created_at desc);
