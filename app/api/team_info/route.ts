export function GET() {
  return Response.json({
    group_batch_order_number: "Batch3_08",
    team_name: "FixGap AI - Lisbon Airbnb Listing Manager",
    students: [
      { name: process.env.TEAM_STUDENT_1_NAME ?? "Shoval Zvieli", email: process.env.TEAM_STUDENT_1_EMAIL ?? "shovalzvieli@campus.technion.ac.il" },
      { name: process.env.TEAM_STUDENT_2_NAME ?? "Daniel Elhadif-Kaminer", email: process.env.TEAM_STUDENT_2_EMAIL ?? "edaniel@campus.technion.ac.il" },
      { name: process.env.TEAM_STUDENT_3_NAME ?? "Opal Zvieli", email: process.env.TEAM_STUDENT_3_EMAIL ?? "opalzvieli@campus.technion.ac.il" }
    ]
  });
}
