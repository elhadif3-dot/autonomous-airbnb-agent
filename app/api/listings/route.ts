import { getManagedDemoListings } from "@/lib/data";

export async function GET() {
  const listings = await getManagedDemoListings(8);
  return Response.json({ listings });
}
