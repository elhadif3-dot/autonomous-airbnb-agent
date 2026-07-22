type LlmMessage = {
  role: "system" | "user";
  content: string;
};

type LlmJsonOptions<T> = {
  module: string;
  messages: LlmMessage[];
  mockResponse: T;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

const DEFAULT_TEXT_MODEL = "MB5R2CF-azure/gpt-5.4-mini";

export async function callLlmJson<T>({ module, messages, mockResponse }: LlmJsonOptions<T>): Promise<T> {
  if (process.env.LLM_MODE !== "live" || !isLiveModuleEnabled(module)) {
    return mockResponse;
  }

  const apiKey = process.env.LLMOD_API_KEY;
  const baseUrl = process.env.LLMOD_BASE_URL;

  if (!apiKey || !baseUrl) {
    throw new Error("LLM_MODE=live requires LLMOD_API_KEY and LLMOD_BASE_URL.");
  }

  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.LLMOD_TEXT_MODEL || DEFAULT_TEXT_MODEL,
      messages,
      temperature: Number(process.env.LLM_TEMPERATURE ?? 0),
      max_tokens: Number(process.env.LLM_MAX_TOKENS ?? 450),
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed for ${module}: HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`LLM returned an empty response for ${module}.`);
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`LLM returned invalid JSON for ${module}.`);
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/chat/completions`;
  }

  return `${trimmed}/v1/chat/completions`;
}

function isLiveModuleEnabled(module: string): boolean {
  const configured = process.env.LLM_LIVE_MODULES?.trim();
  if (!configured || configured.toLowerCase() === "all") {
    return true;
  }

  const moduleKey = module.toLowerCase().includes("supervisor") ? "supervisor" : "agent";
  return configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(moduleKey);
}
