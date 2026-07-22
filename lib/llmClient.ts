type LlmMessage = {
  role: "system" | "user";
  content: string;
};

type LlmJsonOptions<T> = {
  module: string;
  messages: LlmMessage[];
  mockResponse: T;
};

export async function callLlmJson<T>({ mockResponse }: LlmJsonOptions<T>): Promise<T> {
  if (process.env.LLM_MODE !== "live") {
    return mockResponse;
  }

  throw new Error(
    "Live LLM calls are disabled until the project owner explicitly approves token usage."
  );
}
