export function GET() {
  return Response.json({
    group_batch_order_number: "Batch3_08",
    team_name: "Autonomous Lisbon Airbnb Listing Editor",
    students: [
      { name: process.env.TEAM_STUDENT_1_NAME ?? "Shoval", email: process.env.TEAM_STUDENT_1_EMAIL ?? "set-email-in-env@example.com" },
      { name: process.env.TEAM_STUDENT_2_NAME ?? "Daniel", email: process.env.TEAM_STUDENT_2_EMAIL ?? "set-email-in-env@example.com" },
      { name: process.env.TEAM_STUDENT_3_NAME ?? "Ofel", email: process.env.TEAM_STUDENT_3_EMAIL ?? "set-email-in-env@example.com" }
    ]
  });
}
