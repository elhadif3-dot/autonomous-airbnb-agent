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
    body: JSON.stringify(buildChatBody(messages))
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`LLM request failed for ${module}: HTTP ${response.status}. ${errorText.slice(0, 240)}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`LLM returned an empty response for ${module}.`);
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    const extracted = extractJsonObject(content);
    if (extracted) {
      try {
        return JSON.parse(extracted) as T;
      } catch {
        return mockResponse;
      }
    }

    return mockResponse;
  }
}

function buildChatBody(messages: LlmMessage[]) {
  const body: Record<string, unknown> = {
    model: process.env.LLMOD_TEXT_MODEL || DEFAULT_TEXT_MODEL,
    messages: [
      ...messages,
      {
        role: "user",
        content: "Return only valid JSON. Do not include markdown, prose, or code fences."
      }
    ],
    max_tokens: Number(process.env.LLM_MAX_TOKENS ?? 450)
  };

  if (process.env.LLM_TEMPERATURE) {
    body.temperature = Number(process.env.LLM_TEMPERATURE);
  }

  if (process.env.LLM_RESPONSE_FORMAT === "json_object") {
    body.response_format = { type: "json_object" };
  }

  return body;
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

function extractJsonObject(value: string): string | null {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? value;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return candidate.slice(start, end + 1);
}
