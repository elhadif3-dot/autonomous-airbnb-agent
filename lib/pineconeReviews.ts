import { Pinecone } from "@pinecone-database/pinecone";
import { embedText } from "@/lib/embeddingClient";
import type { Review } from "@/lib/types";

type ReviewMetadata = {
  listing_id?: string;
  review_id?: string;
  date?: string;
  text?: string;
  comments?: string;
  source?: string;
};

type PineconeMatch = {
  id?: string;
  metadata?: ReviewMetadata;
};

let pineconeClient: Pinecone | null = null;

export function isPineconeReviewsConfigured(): boolean {
  return Boolean(process.env.PINECONE_API_KEY && pineconeReviewIndexName());
}

export async function queryPineconeReviews(input: {
  listingId: string;
  query: string;
  topK: number;
}): Promise<Review[] | null> {
  if (!isPineconeReviewsConfigured()) {
    return null;
  }

  try {
    const pc = getPineconeClient();
    const index = pc.index(pineconeReviewIndexName());
    const namespace = process.env.PINECONE_REVIEW_NAMESPACE || process.env.PINECONE_NAMESPACE || "airbnb-reviews";
    const vector = await embedText(input.query);
    const target = namespace ? index.namespace(namespace) : index;
    const result = await target.query({
      vector,
      topK: input.topK,
      includeMetadata: true,
      filter: {
        listing_id: { $eq: input.listingId },
        source: { $eq: "airbnb_review" }
      }
    });

    const matches = ((result.matches ?? []) as PineconeMatch[])
      .map((match) => match.metadata)
      .filter((metadata): metadata is ReviewMetadata => Boolean(metadata?.listing_id));

    const reviews = matches
      .map((metadata) => ({
        listingId: String(metadata.listing_id),
        id: String(metadata.review_id ?? crypto.randomUUID()),
        date: String(metadata.date ?? ""),
        comments: String(metadata.text ?? metadata.comments ?? "")
      }))
      .filter((review) => review.listingId === input.listingId && review.comments.trim().length > 0);

    return reviews.length > 0 ? reviews : null;
  } catch (error) {
    console.warn(
      `Pinecone review retrieval failed; falling back to local CSV. ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    return null;
  }
}

function getPineconeClient(): Pinecone {
  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  }

  return pineconeClient;
}

function pineconeReviewIndexName(): string {
  return process.env.PINECONE_REVIEW_INDEX || process.env.PINECONE_INDEX || "";
}
