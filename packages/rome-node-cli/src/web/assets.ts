import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function hasIndexHtml(dir: string): boolean {
  try {
    return statSync(join(dir, "index.html")).isFile();
  } catch {
    return false;
  }
}

export function resolveWebAssetsDir(explicit?: string): string {
  const checked: string[] = [];
  if (explicit) {
    const candidate = resolve(explicit);
    checked.push(candidate);
    if (hasIndexHtml(candidate)) return candidate;
    throw new Error(`Web UI assets not found at ${candidate} (missing index.html).`);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const siblingCandidates = [
    resolve(here, "../../../rome-node-web/dist/web"),
    resolve(here, "../../../../rome-node-web/dist/web"),
    resolve(here, "../../../node-web/dist/web"),
    resolve(here, "../../../../node-web/dist/web"),
  ];
  for (const candidate of siblingCandidates) {
    checked.push(candidate);
    if (hasIndexHtml(candidate)) return candidate;
  }

  let cursor = here;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(cursor, "node_modules", "@rome-os", "node-web", "dist", "web");
    checked.push(candidate);
    if (hasIndexHtml(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  throw new Error(
    `Rome Node Web UI assets were not found. The standalone npm package does not bundle Web UI assets; use the official Docker image (ghcr.io/rome-os/rome-node), build @rome-os/node-web in a monorepo checkout, or pass --assets-dir <dir> (or set ROME_NODE_WEB_ASSETS_DIR). Checked: ${checked.join(", ")}`,
  );
}

function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers["accept-encoding"];
  if (typeof header !== "string") return false;
  return /\bgzip\b/i.test(header);
}

export function createStaticHandler(assetsDir: string) {
  const root = resolve(assetsDir);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const indexPath = join(root, "index.html");

  return async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad request");
      return true;
    }
    if (decoded.includes("\0")) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad request");
      return true;
    }

    const relativePath = decoded.replace(/^\/+/, "");
    let filePath = relativePath ? resolve(root, relativePath) : indexPath;
    if (filePath !== root && !filePath.startsWith(rootPrefix)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
      return true;
    }

    let isFile = false;
    try {
      isFile = statSync(filePath).isFile();
    } catch {
      isFile = false;
    }

    if (!isFile) {
      // SPA fallback for extensionless client routes; missing asset files return 404.
      if (extname(relativePath)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return true;
      }
      filePath = indexPath;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const isImmutable = filePath !== indexPath && relativePath.startsWith("static/");
    const gzipPath = `${filePath}.gz`;
    const useGzip = acceptsGzip(req) && existsSync(gzipPath);

    const body = await readFile(useGzip ? gzipPath : filePath);
    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      "cache-control": isImmutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (useGzip) {
      headers["content-encoding"] = "gzip";
      headers.vary = "Accept-Encoding";
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return true;
  };
}
