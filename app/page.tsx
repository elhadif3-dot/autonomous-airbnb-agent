import { DemoDashboard } from "@/components/DemoDashboard";
import { getListings } from "@/lib/data";

export default async function Home() {
  const listings = await getListings(10);
  return <DemoDashboard listings={listings} />;
}
