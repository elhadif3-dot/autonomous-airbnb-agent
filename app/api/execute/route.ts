import { executeListingAgentWithOptions } from "@/lib/agent";
import type { ExecuteResponse } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      prompt?: unknown;
      current_page_description?: unknown;
      portfolio_page_descriptions?: unknown;
    };

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
      portfolioPageDescriptions: isStringRecord(body.portfolio_page_descriptions)
        ? body.portfolio_page_descriptions
        : undefined
    });
    return Response.json(result, { status: result.status === "error" ? 400 : 200 });
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
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "string");
}
