import type { AgentStep } from "@/lib/types";

type LlmMessage = {
  role: "system" | "user";
  content: string;
};

type LlmJsonOptions<T> = {
  module: string;
  messages: LlmMessage[];
  mockResponse: T;
};

type LlmJsonResult<T> = {
  output: T;
  calledLive: boolean;
  step: AgentStep | null;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

const DEFAULT_TEXT_MODEL = "MB5R2CF-azure/gpt-5.4-mini";
const JSON_ONLY_INSTRUCTION = "Return only valid JSON. Do not include markdown, prose, or code fences.";

export async function callLlmJson<T>(options: LlmJsonOptions<T>): Promise<T> {
  const result = await callLlmJsonWithTrace(options);
  return result.output;
}

export async function callLlmJsonWithTrace<T>({
  module,
  messages,
  mockResponse
}: LlmJsonOptions<T>): Promise<LlmJsonResult<T>> {
  const effectivePrompt = effectivePromptParts(messages);

  if (process.env.LLM_MODE !== "live" || !isLiveModuleEnabled(module)) {
    return {
      output: mockResponse,
      calledLive: false,
      step: null
    };
  }

  const apiKey = process.env.LLMOD_API_KEY;
  const baseUrl = process.env.LLMOD_BASE_URL;

  if (!apiKey || !baseUrl) {
    throw new Error("LLM_MODE=live requires LLMOD_API_KEY and LLMOD_BASE_URL.");
  }

  const output = await requestJsonFromLlm<T>(module, baseUrl, apiKey, effectivePrompt);

  return {
    output,
    calledLive: true,
    step: {
      module,
      prompt: {
        system_prompt: effectivePrompt.system_prompt,
        user_prompt: effectivePrompt.user_prompt
      },
      response: output
    }
  };
}

async function requestJsonFromLlm<T>(
  module: string,
  baseUrl: string,
  apiKey: string,
  prompt: { system_prompt: string; user_prompt: string }
): Promise<T> {
  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildChatBody(prompt))
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

  const parsed = parseJsonObject<T>(content);
  if (!parsed.ok) {
    throw new Error(`LLM returned invalid JSON for ${module}. Raw response: ${content.slice(0, 240)}`);
  }

  return parsed.value;
}

function buildChatBody(prompt: { system_prompt: string; user_prompt: string }) {
  const body: Record<string, unknown> = {
    model: process.env.LLMOD_TEXT_MODEL || DEFAULT_TEXT_MODEL,
    messages: [
      {
        role: "system",
        content: prompt.system_prompt
      },
      {
        role: "user",
        content: prompt.user_prompt
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

function effectivePromptParts(messages: LlmMessage[]): { system_prompt: string; user_prompt: string } {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const user = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);

  const systemPrompt = [...system, JSON_ONLY_INSTRUCTION].join("\n\n");

  return {
    system_prompt: systemPrompt,
    user_prompt: user.join("\n\n")
  };
}

function parseJsonObject<T>(content: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(content) as T };
  } catch {
    const extracted = extractJsonObject(content);
    if (!extracted) {
      return { ok: false };
    }

    try {
      return { ok: true, value: JSON.parse(extracted) as T };
    } catch {
      return { ok: false };
    }
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
