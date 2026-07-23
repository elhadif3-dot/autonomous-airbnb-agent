import type { AuditLogEntry, Listing, Place, SimulatedListingPage, SimulatedPageUpdate } from "@/lib/types";

type QueryParams = Record<string, string | number | boolean | undefined>;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function requireSupabaseRuntime(): boolean {
  return process.env.REQUIRE_SUPABASE_RUNTIME === "true";
}

export function assertSupabaseConfiguredIfRequired(): void {
  if (requireSupabaseRuntime() && !isSupabaseConfigured()) {
    throw new Error("Supabase runtime is required but SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured.");
  }
}

export async function fetchListingsFromSupabase(limit?: number): Promise<Listing[] | null> {
  if (!isSupabaseConfigured()) {
    assertSupabaseConfiguredIfRequired();
    return null;
  }

  const rows = await supabaseRequest<Record<string, unknown>[]>("listings", {
    select: "*",
    ...(typeof limit === "number" ? { limit } : {})
  });

  return rows.map(rowToListing);
}

export async function fetchListingByIdFromSupabase(id: string): Promise<Listing | null> {
  if (!isSupabaseConfigured()) {
    assertSupabaseConfiguredIfRequired();
    return null;
  }

  const rows = await supabaseRequest<Record<string, unknown>[]>("listings", {
    select: "*",
    id: `eq.${id}`,
    limit: 1
  });

  return rows[0] ? rowToListing(rows[0]) : null;
}

export async function fetchGooglePlacesFromSupabase(): Promise<Place[] | null> {
  if (!isSupabaseConfigured()) {
    assertSupabaseConfiguredIfRequired();
    return null;
  }

  const rows = await supabaseRequest<Record<string, unknown>[]>("google_places", {
    select: "*"
  });

  return rows.map((row) => ({
    placeName: stringValue(row.place_name),
    category: stringValue(row.category),
    rating: nullableNumber(row.rating),
    numberOfReviews: numberValue(row.num_of_reviews),
    reviewsContent: stringValue(row.reviews_content),
    latitude: numberValue(row.latitude),
    longitude: numberValue(row.longitude)
  }));
}

export async function getSupabaseSimulatedPage(listing: Listing): Promise<SimulatedListingPage | null> {
  if (!isSupabaseConfigured()) {
    assertSupabaseConfiguredIfRequired();
    return null;
  }

  const rows = await supabaseRequest<Record<string, unknown>[]>("simulated_listing_pages", {
    select: "*",
    listing_id: `eq.${listing.id}`,
    limit: 1
  });

  if (rows[0]) {
    return rowToPage(rows[0]);
  }

  return upsertSupabaseSimulatedPage({
    listingId: listing.id,
    currentDescription: listing.description,
    previousDescription: null,
    updatedAt: new Date().toISOString()
  });
}

export async function upsertSupabaseSimulatedPage(page: SimulatedListingPage): Promise<SimulatedListingPage> {
  if (!isSupabaseConfigured()) {
    assertSupabaseConfiguredIfRequired();
    return page;
  }

  const rows = await supabaseRequest<Record<string, unknown>[]>(
    "simulated_listing_pages",
    {},
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: [
        {
          listing_id: page.listingId,
          current_description: page.currentDescription,
          previous_description: page.previousDescription ?? null,
          updated_at: page.updatedAt
        }
      ]
    }
  );

  return rows[0] ? rowToPage(rows[0]) : page;
}

export async function insertSupabaseAuditLog(audit: AuditLogEntry): Promise<AuditLogEntry> {
  if (!isSupabaseConfigured()) {
    assertSupabaseConfiguredIfRequired();
    return audit;
  }

  const rows = await supabaseRequest<Record<string, unknown>[]>(
    "audit_logs",
    {},
    {
      method: "POST",
      prefer: "return=representation",
      body: [
        {
          id: audit.id,
          listing_id: audit.listingId,
          listing_name: audit.listingName,
          manager_prompt: audit.managerPrompt,
          decision: audit.decision,
          selected_tools: audit.selectedActions,
          evidence_summary: audit.evidenceSummary,
          proposal: audit.proposal,
          page_update: audit.pageUpdate ?? null,
          supervisor_rationale: audit.supervisorRationale,
          executed_in_demo_environment: audit.executedInDemoEnvironment,
          live_airbnb_updated: audit.liveAirbnbUpdated,
          created_at: audit.createdAt
        }
      ]
    }
  );

  return rows[0] ? rowToAudit(rows[0]) : audit;
}

export async function fetchSupabaseAuditLogs(listingId?: string): Promise<AuditLogEntry[] | null> {
  if (!isSupabaseConfigured()) {
    assertSupabaseConfiguredIfRequired();
    return null;
  }

  const rows = await supabaseRequest<Record<string, unknown>[]>("audit_logs", {
    select: "*",
    order: "created_at.desc",
    ...(listingId ? { listing_id: `eq.${listingId}` } : {})
  });

  return rows.map(rowToAudit);
}

async function supabaseRequest<T>(
  table: string,
  params: QueryParams = {},
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; prefer?: string } = {}
): Promise<T> {
  const url = new URL(`${process.env.SUPABASE_URL!.replace(/\/$/, "")}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase ${table} request failed: HTTP ${response.status}. ${text.slice(0, 240)}`);
  }

  return (await response.json()) as T;
}

function rowToListing(row: Record<string, unknown>): Listing {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    description: stringValue(row.description),
    neighbourhood: stringValue(row.neighbourhood ?? row.neighbourhood_cleansed),
    latitude: numberValue(row.latitude),
    longitude: numberValue(row.longitude),
    propertyType: stringValue(row.property_type),
    roomType: stringValue(row.room_type),
    accommodates: numberValue(row.accommodates),
    bathroomsText: stringValue(row.bathrooms_text),
    bedrooms: nullableNumber(row.bedrooms),
    beds: nullableNumber(row.beds),
    amenities: arrayValue(row.amenities),
    price: stringValue(row.price || "N/A"),
    reviewScore: nullableNumber(row.review_score ?? row.review_scores_rating),
    locationScore: nullableNumber(row.location_score ?? row.review_scores_location),
    valueScore: nullableNumber(row.value_score ?? row.review_scores_value),
    numberOfReviews: numberValue(row.number_of_reviews),
    nearbyPlacesCount: numberValue(row.nearby_places_count)
  };
}

function rowToPage(row: Record<string, unknown>): SimulatedListingPage {
  return {
    listingId: stringValue(row.listing_id),
    currentDescription: stringValue(row.current_description),
    previousDescription: typeof row.previous_description === "string" ? row.previous_description : null,
    updatedAt: stringValue(row.updated_at || new Date().toISOString())
  };
}

function rowToAudit(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: stringValue(row.id),
    listingId: stringValue(row.listing_id),
    listingName: stringValue(row.listing_name),
    managerPrompt: stringValue(row.manager_prompt),
    decision: row.decision === "Revise" || row.decision === "Block" ? row.decision : "Approve",
    selectedActions: arrayValue(row.selected_tools),
    evidenceSummary: row.evidence_summary ?? null,
    proposal: row.proposal ?? null,
    pageUpdate: isObject(row.page_update) ? (row.page_update as SimulatedPageUpdate) : null,
    supervisorRationale: stringValue(row.supervisor_rationale),
    executedInDemoEnvironment: Boolean(row.executed_in_demo_environment),
    liveAirbnbUpdated: false,
    createdAt: stringValue(row.created_at || new Date().toISOString())
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function arrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }

  return [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
