import { executeListingAgentWithOptions } from "@/lib/agent";
import type { ExecuteResponse, ReviewCoverageSnapshot } from "@/lib/types";

const DEFAULT_SERVER_BUDGET_MS = 240_000;

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
    return Response.json(errorResponse("Invalid JSON request body."), { status: 400 });
  }

  try {
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return Response.json(errorResponse("Request body must include a non-empty prompt string."), { status: 400 });
    }

    const result = await withServerBudget(
      executeListingAgentWithOptions(body.prompt, {
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
      }),
      serverBudgetMs()
    );
    return Response.json(result, { status: result.status === "error" ? 400 : 200 });
  } catch (error) {
    return Response.json(
      errorResponse(error instanceof Error ? `Agent execution failed: ${error.message}` : "Agent execution failed."),
      { status: 400 }
    );
  }
}

function errorResponse(error: string): ExecuteResponse {
  return {
    status: "error",
    error,
    response: null,
    steps: [],
    page_update: null,
    portfolio_update: null,
    audit_log: null
  };
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
