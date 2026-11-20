import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuditQuery, AuditResult, ContentName } from "@rome-os/node-core/host";
import { createStaticHandler, resolveWebAssetsDir } from "./assets.js";
import { createWebAuth, isSecureRequest } from "./auth.js";
import {
  ControllerInputError,
  HostController,
  type HostControllerDeps,
  type HostControllerEvent,
} from "./host-controller.js";

const MAX_JSON_BYTES = 16 * 1024;
const MAX_CONTENT_PREVIEW_BYTES = 256 * 1024;
const MAX_SSE_CLIENTS = 16;
const SSE_HEARTBEAT_MS = 20_000;
const VALID_RESULTS = new Set<AuditResult>(["succeeded", "failed", "no_result"]);
const VALID_CONTENT_NAMES = new Set<ContentName>(["stdin", "stdout", "stderr", "file"]);

export interface WebServerOptions {
  host: string;
  port: number;
  configDirectory: string;
  cloudUrl?: string;
  explicitCloudUrl?: boolean;
  name?: string;
  explicitName?: boolean;
  assetsDir?: string;
  token?: string;
  requireAuth?: boolean;
  version?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
  deps?: HostControllerDeps;
}

export interface RunningWebServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  readonly authRequired: boolean;
  readonly initialToken: string | null;
  readonly controller: HostController;
  close(): Promise<void>;
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"] ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new ControllerInputError("Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new ControllerInputError("Request body is too large.");
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ControllerInputError("Request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControllerInputError("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseOptionalInt(value: string | null, name: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ControllerInputError(`${name} must be an integer.`);
  }
  return parsed;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const assetsDir = resolveWebAssetsDir(options.assetsDir);
  const serveStatic = createStaticHandler(assetsDir);
  const auth = createWebAuth({
    host: options.host,
    token: options.token,
    requireAuth: options.requireAuth,
    now: options.deps?.now,
  });
  const controller = new HostController({
    configDirectory: options.configDirectory,
    cloudUrl: options.cloudUrl,
    explicitCloudUrl: options.explicitCloudUrl,
    name: options.name,
    explicitName: options.explicitName,
    version: options.version,
    deps: options.deps,
  });
  await controller.start();

  const sseClients = new Set<ServerResponse>();
  const unsubscribeController = controller.subscribe((event: HostControllerEvent) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...sseClients]) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      client.write(payload);
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of [...sseClients]) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      client.write(": ping\n\n");
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof ControllerInputError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Internal server error.",
      });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    const method = req.method ?? "GET";
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const { pathname, searchParams } = parsedUrl;

    if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      if (method === "HEAD") {
        res.writeHead(200, { "cache-control": "no-store" }).end();
      } else {
        sendJson(res, 200, { ok: true });
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD" && !auth.checkSameOrigin(req)) {
        sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
        return;
      }

      if (pathname === "/api/auth/session" && method === "GET") {
        sendJson(res, 200, {
          authRequired: auth.authRequired,
          authenticated: auth.isAuthenticated(req),
        });
        return;
      }

      if (pathname === "/api/auth/login" && method === "POST") {
        if (!auth.authRequired) {
          sendJson(res, 200, { authRequired: false, authenticated: true });
          return;
        }
        const remote = req.socket.remoteAddress ?? "unknown";
        const limit = auth.checkLoginRateLimit(remote);
        if (!limit.allowed) {
          sendJson(
            res,
            429,
            { error: "Too many failed login attempts. Try again shortly." },
            { "retry-after": String(limit.retryAfterSeconds) },
          );
          return;
        }
        const body = await readJsonBody(req);
        const token = typeof body.token === "string" ? body.token.trim() : "";
        if (!auth.verifyToken(token)) {
          auth.recordLoginFailure(remote);
          sendJson(res, 401, { error: "Invalid access token." });
          return;
        }
        auth.clearLoginFailures(remote);
        const sessionId = auth.createSession();
        sendJson(
          res,
          200,
          { authRequired: true, authenticated: true },
          { "set-cookie": auth.sessionCookieHeader(sessionId, isSecureRequest(req)) },
        );
        return;
      }

      if (!auth.isAuthenticated(req)) {
        sendJson(res, 401, { error: "Authentication required." });
        return;
      }

      if (pathname === "/api/auth/logout" && method === "POST") {
        auth.clearSession(req);
        sendJson(
          res,
          200,
          { ok: true },
          { "set-cookie": auth.clearSessionCookieHeader(isSecureRequest(req)) },
        );
        return;
      }

      if (pathname === "/api/status" && method === "GET") {
        sendJson(res, 200, controller.snapshot());
        return;
      }

      if (pathname === "/api/events" && method === "GET") {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          sendJson(res, 503, { error: "Too many active event streams." });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        sseClients.add(res);
        const initial: HostControllerEvent = { type: "status", snapshot: controller.snapshot() };
        res.write(`event: status\ndata: ${JSON.stringify(initial)}\n\n`);
        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      if (pathname === "/api/host/authorize" && method === "POST") {
        const body = await readJsonBody(req);
        const cloudUrl = typeof body.cloudUrl === "string" ? body.cloudUrl : undefined;
        const name = typeof body.name === "string" ? body.name : undefined;
        sendJson(res, 200, await controller.authorize({ cloudUrl, name }));
        return;
      }

      if (pathname === "/api/host/authorize/cancel" && method === "POST") {
        sendJson(res, 200, await controller.cancelAuthorization());
        return;
      }

      if (pathname === "/api/host/connect" && method === "POST") {
        sendJson(res, 200, await controller.connect());
        return;
      }

      if (pathname === "/api/host/disconnect" && method === "POST") {
        sendJson(res, 200, await controller.disconnect());
        return;
      }

      if (pathname === "/api/host/execution" && method === "POST") {
        const body = await readJsonBody(req);
        if (typeof body.enabled !== "boolean") {
          throw new ControllerInputError("enabled must be a boolean.");
        }
        sendJson(res, 200, await controller.setExecutionEnabled(body.enabled));
        return;
      }

      if (pathname === "/api/host/credentials/clear" && method === "POST") {
        sendJson(res, 200, await controller.clearCredentials());
        return;
      }

      if (pathname === "/api/audit/status" && method === "GET") {
        const summary = controller.audit.summary();
        const counts = summary.status.state === "ok" ? controller.audit.resultCounts() : null;
        sendJson(res, 200, { summary, counts });
        return;
      }

      if (pathname === "/api/audit/stats" && method === "GET") {
        const summary = controller.audit.summary();
        if (summary.status.state !== "ok") {
          sendJson(res, 503, { error: summary.status.message, status: summary.status });
          return;
        }
        const now = options.deps?.now ? options.deps.now() : Date.now();
        const bucketMs = Math.max(
          1000,
          parseOptionalInt(searchParams.get("bucketMs"), "bucketMs") ?? 600_000,
        );
        const until = parseOptionalInt(searchParams.get("until"), "until") ?? now;
        const since =
          parseOptionalInt(searchParams.get("since"), "since") ?? until - 24 * 60 * 60 * 1000;
        if (since >= until) {
          throw new ControllerInputError("since must be earlier than until.");
        }
        if (Math.ceil((until - since) / bucketMs) > 1000) {
          throw new ControllerInputError("Stats range cannot exceed 1000 buckets.");
        }
        sendJson(res, 200, controller.audit.stats(since, until, bucketMs));
        return;
      }

      if (pathname === "/api/audit/items" && method === "GET") {
        const summary = controller.audit.summary();
        if (summary.status.state !== "ok") {
          sendJson(res, 503, { error: summary.status.message, status: summary.status });
          return;
        }
        const limitRaw = parseOptionalInt(searchParams.get("limit"), "limit") ?? 50;
        const limit = Math.max(1, Math.min(200, limitRaw));
        const resultParam = searchParams.get("result");
        if (resultParam && !VALID_RESULTS.has(resultParam as AuditResult)) {
          throw new ControllerInputError("Invalid result filter.");
        }
        const actionParam = searchParams.get("action") || undefined;
        const textParam = searchParams.get("text")?.trim() || undefined;
        const query: AuditQuery = {
          requestsOnly: searchParams.get("requestsOnly") !== "false",
          limit: limit + 1,
          beforeSeq: parseOptionalInt(searchParams.get("beforeSeq"), "beforeSeq"),
          since: parseOptionalInt(searchParams.get("since"), "since"),
          until: parseOptionalInt(searchParams.get("until"), "until"),
          action: actionParam,
          result: resultParam ? (resultParam as AuditResult) : undefined,
          text: textParam,
        };
        const rows = controller.audit.list(query);
        const hasMore = rows.length > limit;
        sendJson(res, 200, { items: hasMore ? rows.slice(0, limit) : rows, hasMore });
        return;
      }

      const contentMatch = pathname.match(/^\/api\/audit\/items\/(\d+)\/content\/([a-z]+)$/);
      if (contentMatch && method === "GET") {
        const summary = controller.audit.summary();
        if (summary.status.state !== "ok") {
          sendJson(res, 503, { error: summary.status.message, status: summary.status });
          return;
        }
        const seq = Number(contentMatch[1]);
        const name = contentMatch[2] as ContentName;
        if (!Number.isSafeInteger(seq) || !VALID_CONTENT_NAMES.has(name)) {
          throw new ControllerInputError("Invalid audit content request.");
        }
        const item = controller.audit.get(seq);
        if (!item) {
          sendJson(res, 404, { error: `Record ${seq} not found.` });
          return;
        }
        const ownerSeq = name === "stdin" ? item.seq : (item.end?.seq ?? item.seq);
        const data = controller.audit.content(ownerSeq, name);
        if (!data) {
          sendJson(res, 404, { error: "Content is unavailable or was pruned." });
          return;
        }
        const truncated = data.byteLength > MAX_CONTENT_PREVIEW_BYTES;
        const preview = truncated ? data.subarray(0, MAX_CONTENT_PREVIEW_BYTES) : data;
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(preview.byteLength),
          "cache-control": "no-store",
          "x-content-total-bytes": String(data.byteLength),
          "x-content-truncated": truncated ? "true" : "false",
        });
        res.end(preview);
        return;
      }

      const itemMatch = pathname.match(/^\/api\/audit\/items\/(\d+)$/);
      if (itemMatch && method === "GET") {
        const summary = controller.audit.summary();
        if (summary.status.state !== "ok") {
          sendJson(res, 503, { error: summary.status.message, status: summary.status });
          return;
        }
        const seq = Number(itemMatch[1]);
        const item = controller.audit.get(seq);
        if (!item) {
          sendJson(res, 404, { error: `Record ${seq} not found.` });
          return;
        }
        sendJson(res, 200, item);
        return;
      }

      sendJson(res, 404, { error: "API route not found." });
      return;
    }

    const handled = await serveStatic(req, res, pathname);
    if (!handled) {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" }).end("Method not allowed");
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(heartbeat);
    unsubscribeController();
    await controller.dispose();
    throw error;
  }

  const address = server.address();
  const actualPort = address && typeof address !== "string" ? address.port : options.port;
  const displayHost =
    options.host.includes(":") && !options.host.startsWith("[")
      ? `[${options.host}]`
      : options.host;
  const url = `http://${displayHost}:${actualPort}`;

  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  log(`Rome Node Web UI listening on ${url}`);
  if (auth.tokenGenerated && auth.initialToken) {
    log(`Web UI access token (generated): ${auth.initialToken}`);
    log("Set ROME_NODE_UI_TOKEN to keep a stable token across container restarts.");
  } else if (auth.authRequired) {
    log("Web UI authentication: enabled (ROME_NODE_UI_TOKEN).");
  } else {
    log("Web UI authentication: disabled (loopback only).");
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribeController();
    for (const client of sseClients) {
      client.end();
    }
    sseClients.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await controller.dispose();
  }

  if (options.signal) {
    if (options.signal.aborted) {
      await close();
    } else {
      options.signal.addEventListener(
        "abort",
        () => {
          void close();
        },
        { once: true },
      );
    }
  }

  return {
    server,
    url,
    port: actualPort,
    authRequired: auth.authRequired,
    initialToken: auth.initialToken,
    controller,
    close,
  };
}
