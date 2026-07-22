import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCsv, rowsToObjects } from "@/lib/csv";
import { queryPineconeReviews } from "@/lib/pineconeReviews";
import type { Listing, Place, Review } from "@/lib/types";

let listingsCache: Listing[] | null = null;
let reviewsCache: Review[] | null = null;
let placesCache: Place[] | null = null;

const root = process.cwd();

function asNumber(value: string): number | null {
  if (!value) {
    return null;
  }
  const cleaned = value.replace("$", "").replace(",", "").trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function parseAmenities(value: string): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 12) : [];
  } catch {
    return value
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((item) => item.replaceAll('"', "").trim())
      .filter(Boolean)
      .slice(0, 12);
  }
}

function cleanText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getListings(limit?: number): Promise<Listing[]> {
  if (!listingsCache) {
    const csv = await readFile(path.join(root, "lisbon_listings_final_with_pois.csv"), "utf8");
    const objects = rowsToObjects(parseCsv(csv));
    listingsCache = objects.map((row) => ({
      id: row.id,
      name: cleanText(row.name),
      description: cleanText(row.description),
      neighbourhood: row.neighbourhood_cleansed,
      latitude: asNumber(row.latitude) ?? 0,
      longitude: asNumber(row.longitude) ?? 0,
      propertyType: row.property_type,
      roomType: row.room_type,
      accommodates: asNumber(row.accommodates) ?? 0,
      bathroomsText: row.bathrooms_text,
      bedrooms: asNumber(row.bedrooms),
      beds: asNumber(row.beds),
      amenities: parseAmenities(row.amenities),
      price: row.price || "N/A",
      reviewScore: asNumber(row.review_scores_rating),
      locationScore: asNumber(row.review_scores_location),
      valueScore: asNumber(row.review_scores_value),
      numberOfReviews: asNumber(row.number_of_reviews) ?? 0,
      nearbyPlacesCount: asNumber(row.nearby_places_count) ?? 0
    }));
  }

  return typeof limit === "number" ? listingsCache.slice(0, limit) : listingsCache;
}

export async function getManagedDemoListings(limit = 8): Promise<Listing[]> {
  const listings = await getListings();
  return listings
    .filter((listing) => listing.numberOfReviews >= 40 && listing.description.length > 180)
    .sort(
      (a, b) =>
        b.numberOfReviews + b.nearbyPlacesCount / 40 - (a.numberOfReviews + a.nearbyPlacesCount / 40)
    )
    .slice(0, limit);
}

export async function getListingById(id: string): Promise<Listing | null> {
  const listings = await getListings();
  return listings.find((listing) => listing.id === id) ?? null;
}

async function getAllLocalReviews(): Promise<Review[]> {
  if (!reviewsCache) {
    const csv = await readFile(path.join(root, "lisbon_reviews_final_with_pois.csv"), "utf8");
    const objects = rowsToObjects(parseCsv(csv));
    reviewsCache = objects
      .filter((row) => row.listing_id && row.comments)
      .map((row) => ({
        listingId: row.listing_id,
        id: row.id,
        date: row.date,
        comments: cleanText(row.comments)
      }));
  }

  return reviewsCache;
}

export async function getReviewTextCountForListing(listingId: string): Promise<number> {
  const reviews = await getAllLocalReviews();
  return reviews.filter((review) => review.listingId === listingId).length;
}

export async function getReviewPreviewForListing(listingId: string, limit = 12): Promise<Review[]> {
  const reviews = await getAllLocalReviews();
  return reviews.filter((review) => review.listingId === listingId).slice(0, limit);
}

export async function getReviewSearchResult(
  listingId: string,
  query?: string,
  limit = 80
): Promise<{ reviews: Review[]; source: "pinecone" | "csv_fallback" }> {
  const pineconeReviews = await queryPineconeReviews({
    listingId,
    query: query || `Guest reviews for Lisbon Airbnb listing ${listingId}`,
    topK: Math.min(limit, 80)
  });

  if (pineconeReviews?.length) {
    return { reviews: pineconeReviews, source: "pinecone" };
  }

  const reviews = await getAllLocalReviews();

  return {
    reviews: reviews.filter((review) => review.listingId === listingId).slice(0, limit),
    source: "csv_fallback"
  };
}

export async function getReviewsForListing(listingId: string, query?: string, limit = 80): Promise<Review[]> {
  const result = await getReviewSearchResult(listingId, query, limit);
  return result.reviews;
}

export async function getPlacesNearListing(listing: Listing, limit = 8, radiusKm = 2): Promise<Place[]> {
  if (!placesCache) {
    const csv = await readFile(path.join(root, "lisbon_google_places_filtered.csv"), "utf8");
    const objects = rowsToObjects(parseCsv(csv));
    placesCache = objects
      .filter((row) => row.place_name && row.lat && row.long)
      .map((row) => ({
        placeName: cleanText(row.place_name),
        category: row.category,
        rating: asNumber(row.rating),
        numberOfReviews: asNumber(row.num_of_reviews) ?? 0,
        reviewsContent: cleanText(row.reviews_content),
        latitude: asNumber(row.lat) ?? 0,
        longitude: asNumber(row.long) ?? 0
      }));
  }

  return placesCache
    .map((place) => ({
      ...place,
      distanceKm: distanceKm(listing.latitude, listing.longitude, place.latitude, place.longitude)
    }))
    .filter((place) => (place.distanceKm ?? Infinity) <= radiusKm)
    .sort((a, b) => {
      const scoreA = (a.rating ?? 0) * Math.log10(a.numberOfReviews + 10);
      const scoreB = (b.rating ?? 0) * Math.log10(b.numberOfReviews + 10);
      return scoreB - scoreA;
    })
    .filter((place, index, places) => places.findIndex((item) => item.placeName === place.placeName) === index)
    .slice(0, limit);
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radius * c;
}

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}
