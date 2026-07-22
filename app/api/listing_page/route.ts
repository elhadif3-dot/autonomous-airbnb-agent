import { getListingById } from "@/lib/data";
import { getSimulatedListingPage } from "@/lib/simulatedStore";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return Response.json({ status: "error", error: "Missing id query parameter." }, { status: 400 });
  }

  const listing = await getListingById(id);
  if (!listing) {
    return Response.json({ status: "error", error: "Listing not found." }, { status: 404 });
  }

  return Response.json({
    status: "ok",
    page: getSimulatedListingPage(listing)
  });
}
