import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const listings = rowsToObjects(parseCsv(await readFile(path.join(root, "lisbon_listings_final_with_pois.csv"), "utf8")))
  .map((row) => ({
    id: row.id,
    name: clean(row.name),
    description: clean(row.description),
    neighbourhood: row.neighbourhood_cleansed,
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    property_type: row.property_type,
    room_type: row.room_type,
    accommodates: numberOrNull(row.accommodates),
    bathrooms_text: row.bathrooms_text,
    bedrooms: numberOrNull(row.bedrooms),
    beds: numberOrNull(row.beds),
    amenities: parseAmenities(row.amenities),
    price: row.price || "N/A",
    review_score: numberOrNull(row.review_scores_rating),
    location_score: numberOrNull(row.review_scores_location),
    value_score: numberOrNull(row.review_scores_value),
    number_of_reviews: numberOrNull(row.number_of_reviews) ?? 0,
    nearby_places_count: numberOrNull(row.nearby_places_count) ?? 0
  }));

const places = rowsToObjects(parseCsv(await readFile(path.join(root, "lisbon_google_places_filtered.csv"), "utf8")))
  .filter((row) => row.place_name && row.lat && row.long)
  .map((row) => ({
    place_name: clean(row.place_name),
    category: row.category,
    rating: numberOrNull(row.rating),
    num_of_reviews: numberOrNull(row.num_of_reviews) ?? 0,
    reviews_content: clean(row.reviews_content),
    latitude: numberOrNull(row.lat),
    longitude: numberOrNull(row.long)
  }));

await upsert("listings", listings);
await insertReplace("google_places", places);

console.log(`Seeded ${listings.length} listings and ${places.length} Google Places rows into Supabase.`);

async function upsert(table, rows) {
  for (const chunk of chunks(rows, 400)) {
    await request(table, chunk, "resolution=merge-duplicates");
  }
}

async function insertReplace(table, rows) {
  await fetch(`${supabaseUrl}/rest/v1/${table}?place_name=not.is.null`, {
    method: "DELETE",
    headers: headers()
  });

  for (const chunk of chunks(rows, 400)) {
    await request(table, chunk);
  }
}

async function request(table, body, prefer = "") {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: headers(prefer),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to seed ${table}: HTTP ${response.status}. ${text.slice(0, 300)}`);
  }
}

function headers(prefer = "") {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((item) => item.some((value) => value.trim()));
}

function rowsToObjects(rows) {
  const [headers, ...data] = rows;
  return data.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]))
  );
}

function clean(value) {
  return String(value ?? "").replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
}

function numberOrNull(value) {
  const number = Number(String(value ?? "").replace("$", "").replace(",", "").trim());
  return Number.isFinite(number) ? number : null;
}

function parseAmenities(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}
