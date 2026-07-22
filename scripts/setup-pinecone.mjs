import { Pinecone } from "@pinecone-database/pinecone";
import { loadLocalEnv, pineconeReviewIndexName, requireEnv } from "./env.mjs";

loadLocalEnv();

const args = new Set(process.argv.slice(2));
const create = args.has("--create");
const apiKey = requireEnv("PINECONE_API_KEY");
const indexName = pineconeReviewIndexName();
const dimension = Number(process.env.PINECONE_DIMENSION || 1536);
const metric = process.env.PINECONE_METRIC || "cosine";
const cloud = process.env.PINECONE_CLOUD || "aws";
const region = process.env.PINECONE_REGION || "us-east-1";

const pc = new Pinecone({ apiKey });
const indexes = await pc.listIndexes();
const existing = (indexes.indexes || []).find((index) => index.name === indexName);

if (existing) {
  const description = await pc.describeIndex(indexName);
  console.log(JSON.stringify({
    status: "exists",
    name: description.name,
    dimension: description.dimension,
    metric: description.metric,
    ready: description.status?.ready ?? false,
    spec: description.spec
  }, null, 2));
  process.exit(0);
}

if (!create) {
  console.log(JSON.stringify({
    status: "missing",
    name: indexName,
    next_step: "Run npm run setup-pinecone -- --create after confirming the Pinecone account/region."
  }, null, 2));
  process.exit(0);
}

await pc.createIndex({
  name: indexName,
  dimension,
  metric,
  deletionProtection: "disabled",
  spec: {
    serverless: {
      cloud,
      region
    }
  },
  waitUntilReady: true
});

const description = await pc.describeIndex(indexName);
console.log(JSON.stringify({
  status: "created",
  name: description.name,
  dimension: description.dimension,
  metric: description.metric,
  ready: description.status?.ready ?? false,
  spec: description.spec
}, null, 2));
