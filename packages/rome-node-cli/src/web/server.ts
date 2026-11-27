import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createStaticHandler, resolveWebAssetsDir } from "./assets.js";
import {
  createAuditRateLimiter,
  decodeContentPreview,
  getContentMeta,
  parseAuditListParams,
  parseAuditSeq,
  parseAuditStatsParams,
  parseContentName,
  parseMaxPreviewBytes,
  sanitizeAuditItem,
  sanitizeAuditSummary,
  type AuditContentPreviewResponse,
} from "./audit-api.js";
import {
  createWebAuth,
  DEFAULT_SETUP_WINDOW_MS,
  hasDuplicateHostHeader,
  isSecureRequest,
  parseAllowedSetupHosts,
  resolveSetupWindowMs,
  validateNewPassword,
  type PasswordSource,
} from "./auth.js";
import {
  AuditUnavailableError,
  ControllerInputError,
  HostController,
  type HostControllerDeps,
  type HostControllerEvent,
} from "./host-controller.js";

const MAX_JSON_BYTES = 16 * 1024;
const MAX_SSE_CLIENTS = 16;
const SSE_HEARTBEAT_MS = 20_000;
const SETUP_CONFLICT = { error: "First-run setup is not active.", code: "setup_conflict" };
const SETUP_EXPIRED = {
  error:
    "First-run setup window has expired. Restart the server or set ROME_NODE_UI_PASSWORD to continue.",
  code: "setup_expired",
};
const UNTRUSTED_SETUP_HOST = {
  error:
    "First-run setup only allows localhost, IP addresses, or hosts listed in ROME_NODE_UI_SETUP_HOSTS. Open via localhost/IP, add this host to ROME_NODE_UI_SETUP_HOSTS, or set ROME_NODE_UI_PASSWORD.",
  code: "untrusted_setup_host",
};
const UNTRUSTED_SETUP_HOST_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rome Node — First-Run Setup</title>
  </head>
  <body>
    <main>
      <h1>This host is blocked during first-run setup</h1>
      <p>Open the Web UI via <code>localhost</code> or an IP address.</p>
      <p>To use this domain, add it to <code>ROME_NODE_UI_SETUP_HOSTS</code> and restart Rome Node.</p>
      <p>To skip first-run setup, set <code>ROME_NODE_UI_PASSWORD</code> and restart Rome Node.</p>
    </main>
  </body>
</html>`;

const UNTRUSTED_HOST_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rome Node — Local Access Only</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 32px 16px; background: #faf8f5; color: #1c1917; }
      main { max-width: 560px; margin: 48px auto; background: #fff; border: 1px solid #e7e5e4; border-radius: 14px; padding: 24px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { font-size: 14px; line-height: 1.6; color: #57534e; margin: 8px 0; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f5f5f4; padding: 2px 6px; border-radius: 6px; color: #1c1917; }
    </style>
  </head>
  <body>
    <main>
      <h1>Local access only / 仅限本机免密访问</h1>
      <p>Rome Node Web UI currently has no password set and only allows requests from <code>localhost</code> or <code>127.0.0.1</code>.</p>
      <p>To access remotely, open this UI from localhost and set a custom password, or restart the container with <code>ROME_NODE_UI_PASSWORD</code>.</p>
      <p>当前未设置访问密码，仅允许通过本机（<code>localhost</code> / <code>127.0.0.1</code>）免密访问。如需远程访问，请先在本机 Web UI 中设置自定义密码，或在启动时设置 <code>ROME_NODE_UI_PASSWORD</code> 环境变量。</p>
    </main>
  </body>
</html>`;

export interface WebServerOptions {
  host: string;
  port: number;
  configDirectory: string;
  cloudUrl?: string;
  explicitCloudUrl?: boolean;
  name?: string;
  explicitName?: boolean;
  assetsDir?: string;
  password?: string;
  allowedSetupHosts?: readonly string[];
  setupWindowMs?: number;
  monotonicNow?: () => number;
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
  readonly passwordSource: PasswordSource;
  readonly controller: HostController;
  close(): Promise<void>;
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const assetsDir = resolveWebAssetsDir(options.assetsDir);
  const serveStatic = createStaticHandler(assetsDir);
  const auth = await createWebAuth({
    host: options.host,
    configDirectory: options.configDirectory,
    password: options.password,
    allowedSetupHosts:
      options.allowedSetupHosts ?? parseAllowedSetupHosts(process.env.ROME_NODE_UI_SETUP_HOSTS),
    now: options.deps?.now,
    monotonicNow: options.monotonicNow,
    setupWindowMs: options.setupWindowMs,
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
  function closeAllSseClients(): void {
    for (const client of sseClients) {
      client.end();
    }
    sseClients.clear();
  }

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

  const auditRateLimiter = createAuditRateLimiter(options.deps?.now);

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
      if (error instanceof AuditUnavailableError) {
        sendJson(res, 503, { error: error.message, status: error.auditStatus });
        return;
      }
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Internal server error.",
      });
    });
  });

  function sessionPayload(authenticated: boolean) {
    const setup = auth.setupWindow;
    return {
      authRequired: auth.authRequired,
      authenticated,
      passwordSource: auth.passwordSource,
      canRemovePassword: auth.canRemovePassword,
      ...(setup ? { setup } : {}),
    };
  }

  function rejectInactiveSetup(res: ServerResponse): boolean {
    if (auth.passwordSource !== "setup") {
      sendJson(res, 409, SETUP_CONFLICT);
      return true;
    }
    if (auth.setupWindow?.expired) {
      sendJson(res, 410, SETUP_EXPIRED);
      return true;
    }
    return false;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    if (hasDuplicateHostHeader(req)) {
      sendJson(res, 400, { error: "Duplicate Host header." });
      return;
    }
    const method = req.method ?? "GET";
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = parsedUrl;

    if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      if (method === "HEAD") {
        res.writeHead(200, { "cache-control": "no-store" }).end();
      } else {
        sendJson(res, 200, { ok: true });
      }
      return;
    }

    if (!auth.isTrustedHost(req)) {
      const setup = auth.passwordSource === "setup";
      if (pathname.startsWith("/api/")) {
        sendJson(
          res,
          403,
          setup
            ? UNTRUSTED_SETUP_HOST
            : {
                error:
                  "Local passwordless mode only allows localhost requests. Set a password from localhost or via ROME_NODE_UI_PASSWORD for remote access.",
              },
        );
      } else {
        res
          .writeHead(403, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          })
          .end(setup ? UNTRUSTED_SETUP_HOST_HTML : UNTRUSTED_HOST_HTML);
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      const requireSameOrigin =
        !auth.authRequired ||
        (method !== "GET" && method !== "HEAD") ||
        pathname.startsWith("/api/audit/");
      if (requireSameOrigin && !auth.checkSameOrigin(req)) {
        sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
        return;
      }

      if (pathname === "/api/auth/session" && method === "GET") {
        sendJson(res, 200, sessionPayload(auth.isAuthenticated(req)));
        return;
      }

      if (pathname === "/api/auth/setup" && method === "POST") {
        if (rejectInactiveSetup(res)) return;
        const body = await readJsonBody(req);
        if (rejectInactiveSetup(res)) return;
        const newPasswordError = validateNewPassword(body.newPassword);
        if (newPasswordError) {
          throw new ControllerInputError(newPasswordError);
        }
        const result = await auth.completeSetup(body.newPassword as string);
        if (result.status === "expired") {
          sendJson(res, 410, SETUP_EXPIRED);
          return;
        }
        if (result.status === "conflict") {
          sendJson(res, 409, SETUP_CONFLICT);
          return;
        }
        sendJson(res, 200, sessionPayload(true), {
          "set-cookie": auth.sessionCookieHeader(result.sessionId, isSecureRequest(req)),
        });
        return;
      }

      if (pathname === "/api/auth/login" && method === "POST") {
        if (!auth.authRequired) {
          sendJson(res, 200, sessionPayload(true));
          return;
        }
        if (auth.passwordSource === "setup") {
          sendJson(res, 409, {
            error: "Set the first password in the Web UI before signing in.",
          });
          return;
        }
        const remote = req.socket.remoteAddress ?? "unknown";
        const limit = auth.reserveLoginAttempt(remote);
        if (!limit.allowed) {
          sendJson(
            res,
            429,
            {
              error: `Too many failed login attempts. Try again in ${limit.retryAfterSeconds}s.`,
              retryAfterSeconds: limit.retryAfterSeconds,
            },
            { "retry-after": String(limit.retryAfterSeconds) },
          );
          return;
        }
        try {
          const body = await readJsonBody(req);
          const password = typeof body.password === "string" ? body.password : "";
          if (!(await auth.verifyPassword(password))) {
            limit.finish("failure");
            sendJson(res, 401, { error: "Incorrect password." });
            return;
          }
          limit.finish("success");
          const sessionId = auth.createSession();
          sendJson(res, 200, sessionPayload(true), {
            "set-cookie": auth.sessionCookieHeader(sessionId, isSecureRequest(req)),
          });
          return;
        } finally {
          limit.finish("abort");
        }
      }

      if (!auth.isAuthenticated(req)) {
        sendJson(res, 401, { error: "Authentication required." });
        return;
      }

      if (pathname === "/api/auth/password" && method === "PUT") {
        if (auth.passwordSource === "env") {
          sendJson(res, 409, {
            error: "Password is managed by the ROME_NODE_UI_PASSWORD environment variable.",
          });
          return;
        }
        const requiresCurrentPassword = auth.passwordSource === "file";
        const remote = req.socket.remoteAddress ?? "unknown";
        const limit = requiresCurrentPassword ? auth.reserveLoginAttempt(remote) : null;
        if (limit && !limit.allowed) {
          sendJson(
            res,
            429,
            {
              error: `Too many failed password attempts. Try again in ${limit.retryAfterSeconds}s.`,
              retryAfterSeconds: limit.retryAfterSeconds,
            },
            { "retry-after": String(limit.retryAfterSeconds) },
          );
          return;
        }
        try {
          const body = await readJsonBody(req);
          const newPasswordError = validateNewPassword(body.newPassword);
          if (newPasswordError) {
            throw new ControllerInputError(newPasswordError);
          }
          if (requiresCurrentPassword) {
            const currentPassword =
              typeof body.currentPassword === "string" ? body.currentPassword : "";
            if (!(await auth.verifyPassword(currentPassword))) {
              limit?.finish("failure");
              sendJson(res, 401, { error: "Current password is incorrect." });
              return;
            }
            limit?.finish("success");
          }
          const sessionId = await auth.setPassword(body.newPassword as string);
          closeAllSseClients();
          sendJson(res, 200, sessionPayload(true), {
            "set-cookie": auth.sessionCookieHeader(sessionId, isSecureRequest(req)),
          });
          return;
        } finally {
          limit?.finish("abort");
        }
      }

      if (pathname === "/api/auth/password" && method === "DELETE") {
        if (auth.passwordSource === "env") {
          sendJson(res, 409, {
            error: "Password is managed by the ROME_NODE_UI_PASSWORD environment variable.",
          });
          return;
        }
        if (auth.passwordSource === "none") {
          sendJson(res, 200, sessionPayload(true));
          return;
        }
        if (!auth.canRemovePassword || !auth.isLoopbackRequest(req)) {
          sendJson(res, 403, {
            error:
              "Password can only be removed when the server is bound to localhost and accessed from loopback.",
          });
          return;
        }
        const remote = req.socket.remoteAddress ?? "unknown";
        const limit = auth.reserveLoginAttempt(remote);
        if (!limit.allowed) {
          sendJson(
            res,
            429,
            {
              error: `Too many failed password attempts. Try again in ${limit.retryAfterSeconds}s.`,
              retryAfterSeconds: limit.retryAfterSeconds,
            },
            { "retry-after": String(limit.retryAfterSeconds) },
          );
          return;
        }
        try {
          const body = await readJsonBody(req);
          const currentPassword =
            typeof body.currentPassword === "string" ? body.currentPassword : "";
          if (!(await auth.verifyPassword(currentPassword))) {
            limit.finish("failure");
            sendJson(res, 401, { error: "Current password is incorrect." });
            return;
          }
          limit.finish("success");
          await auth.removePassword();
          closeAllSseClients();
          sendJson(res, 200, sessionPayload(true), {
            "set-cookie": auth.clearSessionCookieHeader(isSecureRequest(req)),
          });
          return;
        } finally {
          limit.finish("abort");
        }
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

      if (pathname.startsWith("/api/audit/")) {
        if (method !== "GET") {
          sendJson(res, 405, { error: "Audit API is read-only." }, { allow: "GET" });
          return;
        }
        const remote = req.socket.remoteAddress ?? "unknown";
        const limit = auditRateLimiter.consume(remote);
        if (!limit.allowed) {
          sendJson(
            res,
            429,
            {
              error: `Too many audit log requests. Try again in ${limit.retryAfterSeconds}s.`,
              retryAfterSeconds: limit.retryAfterSeconds,
            },
            { "retry-after": String(limit.retryAfterSeconds) },
          );
          return;
        }

        if (pathname === "/api/audit/summary") {
          const summary = await controller.getAuditSummary();
          const counts = summary.status.state === "ok" ? await controller.getAuditCounts() : null;
          sendJson(res, 200, sanitizeAuditSummary(summary, counts));
          return;
        }

        if (pathname === "/api/audit/stats") {
          const { since, until, bucketMs } = parseAuditStatsParams(parsedUrl.searchParams);
          sendJson(res, 200, await controller.getAuditStats(since, until, bucketMs));
          return;
        }

        if (pathname === "/api/audit/items") {
          const { query, limit: pageSize } = parseAuditListParams(parsedUrl.searchParams);
          const rows = await controller.listAuditItems(query);
          const hasMore = rows.length > pageSize;
          const items = rows.slice(0, pageSize).map((item) => sanitizeAuditItem(item, "list"));
          sendJson(res, 200, { items, hasMore });
          return;
        }

        function decodePathSegment(raw: string): string {
          try {
            return decodeURIComponent(raw);
          } catch {
            throw new ControllerInputError("Invalid URL path encoding.");
          }
        }

        const itemMatch = /^\/api\/audit\/items\/([^/]+)$/.exec(pathname);
        if (itemMatch) {
          const seq = parseAuditSeq(decodePathSegment(itemMatch[1]!));
          const item = await controller.getAuditItem(seq);
          if (!item) {
            sendJson(res, 404, { error: "Audit record not found." });
            return;
          }
          sendJson(res, 200, { item: sanitizeAuditItem(item, "detail") });
          return;
        }

        const contentMatch = /^\/api\/audit\/items\/([^/]+)\/content\/([^/]+)$/.exec(pathname);
        if (contentMatch) {
          const seq = parseAuditSeq(decodePathSegment(contentMatch[1]!));
          const name = parseContentName(decodePathSegment(contentMatch[2]!));
          const maxBytes = parseMaxPreviewBytes(parsedUrl.searchParams.get("maxBytes"));
          const item = await controller.getAuditItem(seq);
          if (!item) {
            sendJson(res, 404, { error: "Audit record not found." });
            return;
          }
          const contentInfo = getContentMeta(item, name);
          if (!contentInfo) {
            sendJson(res, 404, { error: "Audit content not found." });
            return;
          }
          const preview = await controller.getAuditContentPreview(
            contentInfo.ownerSeq,
            name,
            maxBytes,
          );
          if (!preview) {
            const payload: AuditContentPreviewResponse = {
              seq: item.seq,
              name,
              available: false,
              size: contentInfo.meta.size,
              storedBytes: contentInfo.meta.storedBytes,
              sha256: contentInfo.meta.sha256,
              previewBytes: 0,
              truncated: false,
              isBinary: false,
              text: null,
            };
            sendJson(res, 200, payload);
            return;
          }
          const decoded = decodeContentPreview(preview.preview, preview.truncated);
          const payload: AuditContentPreviewResponse = {
            seq: item.seq,
            name,
            available: true,
            size: preview.size,
            storedBytes: contentInfo.meta.storedBytes,
            sha256: contentInfo.meta.sha256,
            previewBytes: decoded.previewBytes,
            truncated: preview.truncated || decoded.previewBytes < preview.size,
            isBinary: decoded.isBinary,
            text: decoded.text,
          };
          sendJson(res, 200, payload);
          return;
        }

        sendJson(res, 404, { error: "API route not found." });
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
  if (auth.passwordSource === "env") {
    log("Web UI authentication: enabled (ROME_NODE_UI_PASSWORD).");
  } else if (auth.passwordSource === "file") {
    log("Web UI authentication: enabled (custom password).");
  } else if (auth.passwordSource === "setup") {
    const windowMs = resolveSetupWindowMs(options.setupWindowMs);
    const duration =
      windowMs === DEFAULT_SETUP_WINDOW_MS ? "10 minutes" : `${windowMs / 1000} seconds`;
    log(
      `First-run browser password setup is open for ${duration} after startup. Open the Web UI to set a password, or set ROME_NODE_UI_PASSWORD and restart.`,
    );
  } else {
    log(
      "Web UI authentication: passwordless for localhost only (if exposed behind a reverse proxy or tunnel, set a password in the UI or via ROME_NODE_UI_PASSWORD first).",
    );
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribeController();
    closeAllSseClients();
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
    get authRequired() {
      return auth.authRequired;
    },
    get passwordSource() {
      return auth.passwordSource;
    },
    controller,
    close,
  };
}
