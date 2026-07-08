import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const distDir = path.join(root, "dist");
const distDataDir = path.join(distDir, "data");

await rm(distDir, { force: true, recursive: true });
await mkdir(distDir, { recursive: true });
await cp(publicDir, distDir, { recursive: true });

try {
  await access(dataDir);
  await cp(dataDir, distDataDir, { recursive: true });
} catch {
  await mkdir(distDataDir, { recursive: true });
}

try {
  await access(path.join(distDataDir, "latest.json"));
} catch {
  await writeFile(
    path.join(distDataDir, "latest.json"),
    JSON.stringify({ generatedAt: null, days: [], articles: [] }, null, 2) + "\n",
    "utf8",
  );
}

console.log(`Built static site in ${path.relative(root, distDir)}`);
