import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export function loadLocalEnv() {
  for (const filename of [".env.local", ".env"]) {
    const fullPath = path.join(process.cwd(), filename);
    if (!existsSync(fullPath)) {
      continue;
    }

    const text = readFileSync(fullPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

export function pineconeReviewIndexName() {
  return process.env.PINECONE_REVIEW_INDEX || process.env.PINECONE_INDEX || "airbnb-reviews";
}

export function pineconeReviewNamespace() {
  return process.env.PINECONE_REVIEW_NAMESPACE || process.env.PINECONE_NAMESPACE || "airbnb-reviews";
}
