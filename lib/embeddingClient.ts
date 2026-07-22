type EmbeddingResponse = {
  data?: Array<{
    embedding?: number[];
  }>;
};

const DEFAULT_EMBEDDING_MODEL = "MB5R2CF-azure/text-embedding-3-small";

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.LLMOD_API_KEY;
  const baseUrl = process.env.LLMOD_BASE_URL;

  if (!apiKey || !baseUrl) {
    throw new Error("Embedding requires LLMOD_API_KEY and LLMOD_BASE_URL.");
  }

  const response = await fetch(embeddingsUrl(baseUrl), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.LLMOD_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      input: text.slice(0, 6000)
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Embedding request failed: HTTP ${response.status}. ${errorText.slice(0, 240)}`);
  }

  const payload = (await response.json()) as EmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding?.length) {
    throw new Error("Embedding response did not include a vector.");
  }

  return embedding;
}

function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/embeddings")) {
    return trimmed;
  }

  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/embeddings`;
  }

  return `${trimmed}/v1/embeddings`;
}
