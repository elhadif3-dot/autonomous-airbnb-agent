import { executeListingAgent } from "@/lib/agent";
import type { ExecuteResponse } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { prompt?: unknown };

    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      const response: ExecuteResponse = {
        status: "error",
        error: "Request body must include a non-empty prompt string.",
        response: null,
        steps: []
      };
      return Response.json(response, { status: 400 });
    }

    const result = await executeListingAgent(body.prompt);
    return Response.json(result);
  } catch {
    const response: ExecuteResponse = {
      status: "error",
      error: "Invalid JSON request body.",
      response: null,
      steps: []
    };
    return Response.json(response, { status: 400 });
  }
}
