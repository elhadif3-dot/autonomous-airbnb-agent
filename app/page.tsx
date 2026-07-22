import { DemoDashboard } from "@/components/DemoDashboard";
import { getListings } from "@/lib/data";
import { getSimulatedListingPage } from "@/lib/simulatedStore";

export default async function Home() {
  const listings = await getListings(10);
  const simulatedListings = listings.map((listing) => ({
    ...listing,
    description: getSimulatedListingPage(listing).currentDescription
  }));

  return <DemoDashboard listings={simulatedListings} />;
}
