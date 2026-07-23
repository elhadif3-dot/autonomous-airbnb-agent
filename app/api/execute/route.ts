import { executeListingAgentWithOptions } from "@/lib/agent";
import type { AgentStep, ExecuteResponse } from "@/lib/types";

type PublicExecuteResponse = {
  status: "ok" | "error";
  error: string | null;
  response: string | null;
  steps: AgentStep[];
};

const DEFAULT_SERVER_BUDGET_MS = 240_000;

export async function POST(request: Request) {
  let body: { prompt?: unknown };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      publicError("Invalid JSON request body.", []),
      { status: 400 }
    );
  }

  try {
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return Response.json(
        publicError("Request body must include a non-empty prompt string.", []),
        { status: 400 }
      );
    }

    const result = await withServerBudget(
      executeListingAgentWithOptions(body.prompt),
      serverBudgetMs()
    );
    const publicResponse = toPublicExecuteResponse(result);
    return Response.json(publicResponse, { status: publicResponse.status === "error" ? 400 : 200 });
  } catch (error) {
    return Response.json(
      publicError(
        error instanceof Error ? `Agent execution failed: ${error.message}` : "Agent execution failed.",
        []
      ),
      { status: 400 }
    );
  }
}

function toPublicExecuteResponse(result: ExecuteResponse): PublicExecuteResponse {
  return {
    status: result.status,
    error: result.error,
    response: result.response,
    steps: result.steps.filter(isLlmStep)
  };
}

function publicError(error: string, steps: AgentStep[]): PublicExecuteResponse {
  return {
    status: "error",
    error,
    response: null,
    steps: steps.filter(isLlmStep)
  };
}

function isLlmStep(step: AgentStep): boolean {
  return step.module === "Autonomous Listing Editor Agent" || step.module === "Supervisor / Control Agent";
}

async function withServerBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Server-side execution budget exceeded ${timeoutMs}ms.`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function serverBudgetMs(): number {
  const configured = Number(process.env.EXECUTE_SERVER_BUDGET_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, 290_000);
  }

  return DEFAULT_SERVER_BUDGET_MS;
}
