import { DemoDashboard } from "@/components/DemoDashboard";
import { getManagedDemoListings, getReviewsForListing } from "@/lib/data";

export default async function Home() {
  const listings = await getManagedDemoListings(8);
  const simulatedListings = await Promise.all(
    listings.map(async (listing) => ({
      ...listing,
      recentReviews: (await getReviewsForListing(listing.id)).slice(0, 12)
    }))
  );

  return <DemoDashboard listings={simulatedListings} />;
}
