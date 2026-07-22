import { getAuditLogs } from "@/lib/simulatedStore";

export function GET(request: Request) {
  const url = new URL(request.url);
  const listingId = url.searchParams.get("listing_id") ?? undefined;

  return Response.json({
    status: "ok",
    audit_logs: getAuditLogs(listingId)
  });
}
