import { getListingById } from "@/lib/data";
import { resetReviewCoverageForListing } from "@/lib/reviewCoverageStore";
import { resetSimulatedListingPage } from "@/lib/simulatedStore";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { listing_id?: unknown; session_id?: unknown };

  if (typeof body.listing_id !== "string") {
    return Response.json({ status: "error", error: "Missing listing_id." }, { status: 400 });
  }

  const listing = await getListingById(body.listing_id);
  if (!listing) {
    return Response.json({ status: "error", error: "Listing not found." }, { status: 404 });
  }

  if (typeof body.session_id === "string") {
    resetReviewCoverageForListing(body.session_id, listing.id);
  }

  return Response.json({
    status: "ok",
    page: resetSimulatedListingPage(listing)
  });
}
