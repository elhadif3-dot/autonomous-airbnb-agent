export function GET() {
  return Response.json({
    description:
      "An autonomous demo agent for Lisbon short-term-rental managers. It compares a simulated Airbnb listing page with real guest reviews and nearby Google Places context, proposes narrow page edits, and executes them only after Supervisor approval.",
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
              tool_input: { listing_id: "176153", topics: ["review_alignment", "stairs", "temperature"], top_k: 18 },
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
          "I manage 8 Lisbon Airbnb listings in this demo portfolio. Autonomously review all managed listings end to end. Prioritize gaps between guest reviews and current page descriptions; use Google Places only as supporting context; update only pages with strong evidence-backed improvements; and give me a per-listing audit summary.",
        full_response:
          "Portfolio request completed. The agent selected the evidence-rich managed listings, ran each listing independently, prioritized guest-review gaps, updated only approved simulated page text, and reported per-listing decisions.",
        steps: [
          {
            module: "Input Scope Guard",
            prompt: {
              system_prompt: "Check whether the request belongs to the agent's allowed domain before using retrieval or LLM.",
              user_prompt: "Portfolio manager request for all managed Lisbon Airbnb listings."
            },
            response: {
              in_scope: true,
              category: "listing_page_management",
              token_safety: "No LLM, Review RAG, or Google Places calls happen before this guard passes."
            }
          },
          {
            module: "Portfolio Manager",
            prompt: {
              system_prompt: "Select the manager-owned demo listings with the richest evidence.",
              user_prompt: "All managed listings request."
            },
            response: {
              requested_listings: 8,
              selection_rule: "Highest Airbnb review count plus nearby Google Places coverage."
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
