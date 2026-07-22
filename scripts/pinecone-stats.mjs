import { Pinecone } from "@pinecone-database/pinecone";
import {
  loadLocalEnv,
  pineconeReviewIndexName,
  pineconeReviewNamespace,
  requireEnv
} from "./env.mjs";

loadLocalEnv();

const pc = new Pinecone({ apiKey: requireEnv("PINECONE_API_KEY") });
const indexName = pineconeReviewIndexName();
const namespace = pineconeReviewNamespace();
const stats = await pc.index(indexName).describeIndexStats();

console.log(JSON.stringify({
  index: indexName,
  namespace,
  dimension: stats.dimension,
  totalVectorCount: stats.totalRecordCount ?? stats.totalVectorCount ?? 0,
  namespaces: stats.namespaces || {}
}, null, 2));
