import { DemoDashboard } from "@/components/DemoDashboard";
import { getListings, getReviewsForListing } from "@/lib/data";

export default async function Home() {
  const allListings = await getListings();
  const listings = allListings
    .filter((listing) => listing.numberOfReviews >= 40 && listing.description.length > 180)
    .sort(
      (a, b) =>
        b.numberOfReviews + b.nearbyPlacesCount / 40 - (a.numberOfReviews + a.nearbyPlacesCount / 40)
    )
    .slice(0, 8);
  const simulatedListings = await Promise.all(
    listings.map(async (listing) => ({
      ...listing,
      recentReviews: (await getReviewsForListing(listing.id)).slice(0, 12)
    }))
  );

  return <DemoDashboard listings={simulatedListings} />;
}
