import { getListingById, getListings, getManagedDemoListings, getReviewsForListing } from "@/lib/data";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    const listing = await getListingById(id);
    if (!listing) {
      return Response.json({ status: "error", error: "Listing not found." }, { status: 404 });
    }

    return Response.json({
      status: "ok",
      listing: {
        ...listing,
        recentReviews: (await getReviewsForListing(listing.id)).slice(0, 12)
      }
    });
  }

  const [managedListings, allListings] = await Promise.all([
    getManagedDemoListings(8),
    getListings()
  ]);
  const managedIds = new Set(managedListings.map((listing) => listing.id));
  const listingOptions = [
    ...managedListings,
    ...allListings.filter((listing) => !managedIds.has(listing.id))
  ].map((listing) => ({
    id: listing.id,
    name: listing.name,
    neighbourhood: listing.neighbourhood,
    numberOfReviews: listing.numberOfReviews,
    nearbyPlacesCount: listing.nearbyPlacesCount,
    reviewScore: listing.reviewScore
  }));

  return Response.json({
    status: "ok",
    managed_count: managedListings.length,
    total_dataset_listings: allListings.length,
    listing_options: listingOptions
  });
}
