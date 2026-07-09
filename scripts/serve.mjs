import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { firstEnv, loadDotEnv } from "./env.mjs";

const root = process.cwd();
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
await loadDotEnv(path.join(root, ".env"));

const host = process.env.HOST || "0.0.0.0";
const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
const startPort = Number(process.env.PORT || 4173);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".otf", "font/otf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function safePath(baseDir, requestPath) {
  const resolved = path.resolve(baseDir, `.${requestPath}`);
  return resolved === baseDir || resolved.startsWith(`${baseDir}${path.sep}`) ? resolved : null;
}

function fileForUrl(url) {
  const parsed = new URL(url, `http://${displayHost}`);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith("/data/")) {
    return safePath(dataDir, pathname.slice("/data".length));
  }

  if (pathname === "/") {
    return path.join(publicDir, "index.html");
  }

  return safePath(publicDir, pathname);
}

function sendJson(response, status, payload, includeBody = true) {
  const body = JSON.stringify(payload, null, 2) + "\n";
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(includeBody ? body : undefined);
}

function publicSupabaseConfig() {
  return {
    supabaseAnonKey: firstEnv("SUPABASE_ANON_KEY", "PUBLIC_SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY"),
    supabaseUrl: firstEnv("SUPABASE_URL", "PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL"),
  };
}

async function readLatestFeed() {
  const remoteFeed = await readRemoteFeed();
  if (remoteFeed) {
    return remoteFeed;
  }

  const fallback = await readFile(path.join(dataDir, "latest.json"), "utf8");
  return JSON.parse(fallback);
}

async function readRemoteFeed() {
  const supabaseUrl = firstEnv("SUPABASE_URL", "PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL");
  const serviceRoleKey = firstEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  const endpoint = new URL("/rest/v1/feed_runs", supabaseUrl);
  endpoint.search = new URLSearchParams({
    limit: "1",
    order: "created_at.desc",
    select: "payload",
  }).toString();

  try {
    const response = await fetch(endpoint, {
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Supabase feed read failed with HTTP ${response.status}`);
    }

    const rows = await response.json();
    return rows?.[0]?.payload || null;
  } catch (error) {
    console.warn(error.message);
    return null;
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    const parsed = new URL(request.url || "/", `http://${request.headers.host || displayHost}`);
    const readsOnly = request.method === "GET" || request.method === "HEAD";
    const includeBody = request.method !== "HEAD";

    if (!readsOnly) {
      response.writeHead(405, {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Method not allowed");
      return;
    }

    if (parsed.pathname === "/api/health") {
      sendJson(response, 200, { ok: true }, includeBody);
      return;
    }

    if (parsed.pathname === "/api/config") {
      sendJson(response, 200, publicSupabaseConfig(), includeBody);
      return;
    }

    if (parsed.pathname === "/api/feed") {
      try {
        sendJson(response, 200, await readLatestFeed(), includeBody);
      } catch (error) {
        sendJson(response, 500, { error: error.message }, includeBody);
      }
      return;
    }

    const filePath = fileForUrl(request.url || "/");

    if (!filePath) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error("Not a file");
      }

      response.writeHead(200, {
        "Content-Length": fileStat.size,
        "Content-Type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream",
      });
      if (!includeBody) {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

async function listen(port) {
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(listen(port + 1));
        return;
      }
      reject(error);
    });

    server.listen(port, host, () => resolve({ port, server }));
  });
}

const { port } = await listen(startPort);
console.log(`The Comment Times is running at http://${displayHost}:${port}/`);
