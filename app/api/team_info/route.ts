export function GET() {
  return Response.json({
    group_batch_order_number: "Batch3_08",
    team_name: "Autonomous Lisbon Airbnb Listing Editor",
    students: [
      { name: "Shoval", email: "TODO" },
      { name: "Daniel", email: "TODO" },
      { name: "Ofel", email: "TODO" }
    ]
  });
}
