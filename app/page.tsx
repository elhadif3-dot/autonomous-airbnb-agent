import { DemoDashboard } from "@/components/DemoDashboard";
import { getListings, getManagedDemoListings, getReviewsForListing } from "@/lib/data";

export default async function Home() {
  const [managedListings, allListings] = await Promise.all([
    getManagedDemoListings(8),
    getListings()
  ]);
  const simulatedListings = await Promise.all(
    managedListings.map(async (listing) => ({
      ...listing,
      recentReviews: (await getReviewsForListing(listing.id)).slice(0, 12)
    }))
  );
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

  return (
    <DemoDashboard
      initialListings={simulatedListings}
      listingOptions={listingOptions}
      managedCount={managedListings.length}
      totalDatasetListings={allListings.length}
    />
  );
}
