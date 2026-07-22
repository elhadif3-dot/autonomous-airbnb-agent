export function GET() {
  return Response.json({
    description:
      "An autonomous demo agent for Lisbon short-term-rental managers. It compares a simulated Airbnb listing page with real guest reviews and nearby Google Places context, proposes narrow page edits, and executes them only after Supervisor approval.",
    purpose:
      "Keep a Lisbon Airbnb listing page aligned with real guest experience while avoiding invented claims, live scraping, and unnecessary LLM calls.",
    prompt_template: {
      template:
        "Selected listing id: <listing_id>\nCheck this listing for gaps between guest reviews, current listing claims, and nearby Google Places context. If evidence is strong, update the simulated listing page and record an audit log."
    },
    prompt_examples: [
      {
        prompt:
          "Selected listing id: 1000509524156083637\nFind positive nearby highlights that are missing from the listing page and add only evidence-backed text.",
        full_response:
          "Approved and executed in the demo environment. The agent added a concise nearby-highlights note based on retrieved Google Places context and recorded that no live Airbnb account was accessed.",
        steps: [
          {
            module: "Autonomous Listing Editor Agent",
            prompt: {
              system_prompt: "Reason about the manager request and decide what information is needed.",
              user_prompt: "Find positive nearby highlights that are missing from the listing page."
            },
            response: {
              selected_tools: ["get_listing_data", "search_reviews", "get_google_places", "draft_listing_edit", "submit_to_supervisor"]
            }
          },
          {
            module: "Supervisor / Control Agent",
            prompt: {
              system_prompt: "Approve, revise, or block the proposed page action.",
              user_prompt: "Review proposed nearby-highlights edit."
            },
            response: {
              decision: "Approve",
              rationale: "The edit is narrow, contextual, and limited to the simulated listing page."
            }
          }
        ]
      }
    ]
  });
}
