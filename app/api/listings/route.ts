import { getListings } from "@/lib/data";

export async function GET() {
  const listings = await getListings(20);
  return Response.json({ listings });
}
