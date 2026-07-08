import { readFile } from "node:fs/promises";
import path from "node:path";
import { firstEnv, loadDotEnv } from "./env.mjs";

const root = process.cwd();
await loadDotEnv(path.join(root, ".env"));

const supabaseUrl = firstEnv("SUPABASE_URL", "PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL");
const serviceRoleKey = firstEnv("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  console.warn("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing; skipping feed upload.");
  process.exit(0);
}

const latestPath = path.join(root, "data", "latest.json");
const payload = JSON.parse(await readFile(latestPath, "utf8"));
const endpoint = new URL("/rest/v1/feed_runs", supabaseUrl);

const response = await fetch(endpoint, {
  body: JSON.stringify({
    generated_at: payload.generatedAt || new Date().toISOString(),
    mode: payload.mode || {},
    payload,
  }),
  headers: {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
    prefer: "return=minimal",
  },
  method: "POST",
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Supabase feed upload failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
}

console.log(`Uploaded ${payload.articles?.length || 0} articles to Supabase feed_runs.`);
