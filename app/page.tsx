import { DemoDashboard } from "@/components/DemoDashboard";
import { getListings, getPlacesNearListing, getReviewsForListing } from "@/lib/data";
import { getSimulatedListingPage } from "@/lib/simulatedStore";

export default async function Home() {
  const listings = await getListings(10);
  const simulatedListings = await Promise.all(
    listings.map(async (listing) => ({
      ...listing,
      description: getSimulatedListingPage(listing).currentDescription,
      nearbyPlaces: (await getPlacesNearListing(listing, 6)).map((place) => ({
        placeName: place.placeName,
        category: place.category,
        rating: place.rating,
        distanceKm: place.distanceKm
      })),
      recentReviews: (await getReviewsForListing(listing.id)).slice(0, 4)
    }))
  );

  return <DemoDashboard listings={simulatedListings} />;
}
