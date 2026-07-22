export function GET() {
  return Response.json({
    description:
      "An autonomous demo agent for Lisbon short-term-rental managers. It compares a simulated Airbnb listing page with real guest reviews and nearby Google Places context, proposes narrow page edits, executes them only after Supervisor approval, and can also recommend fixable property improvements from guest reviews.",
    purpose:
      "Keep Lisbon Airbnb listing pages aligned with real guest experience while avoiding invented claims, live scraping, out-of-scope requests, and unnecessary LLM calls.",
    prompt_template: {
      template:
        "Selected listing id: <listing_id>\nHi, I manage several Airbnb listings in Lisbon. Handle this listing end to end: inspect the current simulated page, choose only the tools needed, use guest reviews as primary evidence, use Google Places only as supporting context when relevant, update only allowed page text if Supervisor approves, and record an audit log."
    },
    prompt_examples: [
      {
        prompt:
          "Selected listing id: 176153\nHi, I manage several Airbnb listings in Lisbon. Please handle The White House end to end: compare the current page with guest reviews first, use nearby context only when useful, decide what is safe to improve, update the simulated listing page, and tell me exactly what changed.",
        full_response:
          "Approved and executed in the demo environment. The agent selected actions dynamically, found review-backed expectation gaps, updated only the simulated page description, and recorded that no live Airbnb account was accessed.",
        steps: [
          {
            module: "Autonomous Listing Editor Agent",
            prompt: {
              system_prompt: "Reason about the manager request, current state, and previous observations. Choose one next action.",
              user_prompt: "State includes listing_id, selected_actions_so_far, observations gathered, and whether Supervisor approval exists."
            },
            response: {
              next_action: "search_reviews",
              tool_input: { listing_id: "176153", topics: ["review_alignment", "stairs", "temperature"], top_k: 36 },
              short_rationale: "Guest reviews are the primary evidence source before drafting a page edit.",
              state_update: "Review evidence is missing.",
              should_stop: false
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
              rationale: "The edit is narrow, review-backed, and limited to the simulated listing page."
            }
          },
          {
            module: "Edit & Decision Tools",
            prompt: {
              system_prompt: "Execute only approved simulated page updates and write an audit log.",
              user_prompt: "Supervisor approved the proposal for the selected listing."
            },
            response: {
              page_update: {
                status: "executed",
                field: "description",
                liveAirbnbUpdated: false
              }
            }
          }
        ]
      },
      {
        prompt:
          "Selected listing id: 176153\nFor The White House, do not edit the page. Use guest reviews to tell me which fixable property or operations issues are bothering guests, what I should improve first, and why it could improve reviews, bookings, or listing quality.",
        full_response:
          "The agent did not edit the listing page. It used read-only guest reviews and returned manager-facing recommendations with priority, guest signal, suggested action, business value, and evidence count.",
        steps: [
          {
            module: "Autonomous Listing Editor Agent",
            prompt: {
              system_prompt: "Choose one next action from the current state.",
              user_prompt: "Manager asked for fixable property or operations issues, not a page edit."
            },
            response: {
              next_action: "draft_manager_recommendations",
              short_rationale: "The manager wants operational recommendations based on guest reviews.",
              should_stop: false
            }
          },
          {
            module: "Manager Insight Tools",
            prompt: {
              system_prompt: "Draft property improvement recommendations from read-only guest reviews.",
              user_prompt: "Review signals for selected listing."
            },
            response: {
              recommendations: [
                {
                  topic: "Temperature comfort",
                  priority: "high",
                  evidenceCount: 2
                }
              ],
              editable_scope: "No page update is executed by this tool."
            }
          }
        ]
      },
      {
        prompt: "Selected listing id: 45855270\nFind me car tires in Lisbon.",
        full_response:
          "I don't know how to complete that request with my allowed tools. No LLM, RAG, Google Places, or page edit was used.",
        steps: [
          {
            module: "Input Scope Guard",
            prompt: {
              system_prompt: "Check whether the request belongs to the agent's allowed domain before using retrieval or LLM.",
              user_prompt: "Find me car tires in Lisbon."
            },
            response: {
              in_scope: false,
              category: "out_of_scope",
              reason: "The request is unrelated to Lisbon Airbnb listing-page management."
            }
          }
        ]
      },
      {
        prompt:
          "Selected listing id: 1000509524156083637\nI did not like the simulated edit. Restore this listing page to the original dataset text and record what you restored.",
        full_response:
          "Approved and executed in the demo environment. The agent restored the simulated listing description from the original read-only dataset row and wrote an audit log.",
        steps: [
          {
            module: "Autonomous Listing Editor Agent",
            prompt: {
              system_prompt: "Choose one next action from the current state.",
              user_prompt: "Manager asked to undo the simulated page edit."
            },
            response: {
              next_action: "restore_original_page",
              short_rationale: "The request is a controlled restore, so review retrieval and Google Places are not needed.",
              should_stop: false
            }
          }
        ]
      }
    ]
  });
}
