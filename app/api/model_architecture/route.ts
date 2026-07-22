import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET() {
  const image = await readFile(path.join(process.cwd(), "public", "model-architecture.png"));

  return new Response(new Uint8Array(image), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600"
    }
  });
}
