import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadDotEnv } from "./env.mjs";

const root = process.cwd();
await loadDotEnv(path.join(root, ".env"));

const expectedHour = String(process.env.SCHEDULE_LOCAL_HOUR || "6").padStart(2, "0");
const actualHour = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
  timeZone: "America/Los_Angeles",
}).format(new Date());

if (process.env.SKIP_SCHEDULE_GUARD !== "1" && actualHour !== expectedHour) {
  console.log(`Not ${expectedHour}:00 in America/Los_Angeles; skipping scheduled scrape.`);
  process.exit(0);
}

run("npm", ["run", "scrape", "--", "--force", "--past-24h", "--deep"]);
run("node", ["scripts/upload-feed.mjs"]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
