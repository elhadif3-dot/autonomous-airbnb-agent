import { readFile } from "node:fs/promises";
import { Pinecone } from "@pinecone-database/pinecone";
import { parseCsv, rowsToObjects } from "./csv.mjs";
import {
  loadLocalEnv,
  pineconeReviewIndexName,
  pineconeReviewNamespace,
  requireEnv
} from "./env.mjs";

loadLocalEnv();

const args = process.argv.slice(2);
const argSet = new Set(args);
if (!argSet.has("--confirm-paid")) {
  throw new Error("Refusing to ingest without --confirm-paid because this calls the embedding model.");
}

const limit = numberArg("--limit", 0);
const batchSize = numberArg("--batch-size", 32);
const namespace = pineconeReviewNamespace();
const indexName = pineconeReviewIndexName();
const apiKey = requireEnv("PINECONE_API_KEY");

const rows = rowsToObjects(parseCsv(await readFile("lisbon_reviews_final_with_pois.csv", "utf8")))
  .filter((row) => row.listing_id && row.id && row.comments)
  .slice(0, limit > 0 ? limit : undefined);

const pc = new Pinecone({ apiKey });
const target = pc.index(indexName).namespace(namespace);

let upserted = 0;
for (let offset = 0; offset < rows.length; offset += batchSize) {
  const batch = rows.slice(offset, offset + batchSize);
  const embeddings = await embedTexts(batch.map((row) => cleanText(row.comments)));
  const vectors = batch.map((row, index) => ({
    id: `review-${row.listing_id}-${row.id}`,
    values: embeddings[index],
    metadata: {
      listing_id: row.listing_id,
      review_id: row.id,
      date: row.date || "",
      source: "airbnb_review",
      text: cleanText(row.comments).slice(0, 6000)
    }
  }));

  await target.upsert(vectors);
  upserted += vectors.length;
  console.log(JSON.stringify({
    status: "batch_upserted",
    upserted,
    total: rows.length,
    namespace,
    index: indexName
  }));
}

console.log(JSON.stringify({
  status: "complete",
  upserted,
  namespace,
  index: indexName
}, null, 2));

async function embedTexts(texts) {
  const apiKey = requireEnv("LLMOD_API_KEY");
  const baseUrl = requireEnv("LLMOD_BASE_URL");
  const model = process.env.LLMOD_EMBEDDING_MODEL || "MB5R2CF-azure/text-embedding-3-small";
  const response = await fetch(embeddingsUrl(baseUrl), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: texts.map((text) => text.slice(0, 6000))
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Embedding request failed: HTTP ${response.status}. ${errorText.slice(0, 240)}`);
  }

  const payload = await response.json();
  const embeddings = payload.data?.map((item) => item.embedding) ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, got ${embeddings.length}.`);
  }

  return embeddings;
}

function embeddingsUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/embeddings")) {
    return trimmed;
  }

  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/embeddings`;
  }

  return `${trimmed}/v1/embeddings`;
}

function numberArg(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) {
    return fallback;
  }

  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function cleanText(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
