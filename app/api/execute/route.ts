import { executeListingAgentWithOptions } from "@/lib/agent";
import type { ExecuteResponse, ReviewCoverageSnapshot } from "@/lib/types";

export async function POST(request: Request) {
  let body: {
    prompt?: unknown;
    current_page_description?: unknown;
    previous_page_description?: unknown;
    portfolio_page_descriptions?: unknown;
    review_coverage_state?: unknown;
    session_id?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    const response: ExecuteResponse = {
      status: "error",
      error: "Invalid JSON request body.",
      response: null,
      steps: [],
      page_update: null,
      portfolio_update: null,
      audit_log: null
    };
    return Response.json(response, { status: 400 });
  }

  try {
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      const response: ExecuteResponse = {
        status: "error",
        error: "Request body must include a non-empty prompt string.",
        response: null,
        steps: [],
        page_update: null,
        portfolio_update: null,
        audit_log: null
      };
      return Response.json(response, { status: 400 });
    }

    const result = await executeListingAgentWithOptions(body.prompt, {
      currentPageDescription:
        typeof body.current_page_description === "string" ? body.current_page_description : undefined,
      previousPageDescription:
        typeof body.previous_page_description === "string" ? body.previous_page_description : undefined,
      portfolioPageDescriptions: isStringRecord(body.portfolio_page_descriptions)
        ? body.portfolio_page_descriptions
        : undefined,
      reviewCoverageState: isReviewCoverageSnapshot(body.review_coverage_state)
        ? body.review_coverage_state
        : undefined,
      sessionId: typeof body.session_id === "string" ? body.session_id : undefined
    });
    return Response.json(result, { status: result.status === "error" ? 400 : 200 });
  } catch (error) {
    const response: ExecuteResponse = {
      status: "error",
      error: error instanceof Error ? `Agent execution failed: ${error.message}` : "Agent execution failed.",
      response: null,
      steps: [],
      page_update: null,
      portfolio_update: null,
      audit_log: null
    };
    return Response.json(response, { status: 400 });
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "string");
}

function isReviewCoverageSnapshot(value: unknown): value is ReviewCoverageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const candidate = item as Record<string, unknown>;
    return (
      typeof candidate.cursor === "number" &&
      Array.isArray(candidate.coveredIds) &&
      candidate.coveredIds.every((id) => typeof id === "string") &&
      typeof candidate.completed === "boolean" &&
      typeof candidate.updatedAt === "string"
    );
  });
}
