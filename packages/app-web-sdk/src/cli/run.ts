import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import {
  ActionInvocationError,
  type ChannelMessage,
  type RomeAppApiHandler,
  type RomeAppContext,
  type ThreadContext,
} from "@rome-os/app-runtime";
import { appIdToPathSegment } from "@rome-os/app-runtime/packaging";
import { createTestApp, type TestApp } from "@rome-os/app-runtime/testing";
import {
  loadActionModules,
  loadApiFactory,
  loadHookFactory,
  readAppOnDisk,
  type AppOnDisk,
} from "./appModules.js";
import type { RomeAppBootstrap } from "../runtime/index.js";
import { runBuild } from "./build.js";
import { CliError } from "./store/config.js";

const HELP = `rome run — serve one app locally, with no Rome daemon

Usage: rome run [--port 4319] [--no-build] [--channels <file.json>]
                [--theme light|dark] [--theme-name ember|ash|slate]

Builds the app, runs its migrations into an in-memory SQLite, runs its
app-started hook, and serves:

  /apps/<id>                 the web UI, mounted in a shadow root with the
                             dashboard's theme tokens (?theme=dark to switch)
  /api/apps/<id>/...         the app's API, called as the guardian
  POST /__rome/actions/<n>   run an action: {"args": {...}, "channel": {...}}
  GET  /__rome/channels      every channel read and send so far
  POST /__rome/channels      add messages to the fake channel history
  GET  /__rome/logs          what the app logged
  GET  /__rome               a summary of all of the above

--channels seeds the fake channel history from a JSON array of messages
({channel, text, conversationId?, senderId?, senderDisplayName?, timestamp?}).
Give conversationId the threadId an action runs in, or a history query for
that conversation finds nothing.
State lives in memory and resets on restart. Agents, favors and real
channels are not available; an action that calls them fails with an error
naming the service. Routines do not run, so listRoutines returns an empty
list.
`;

export interface RunOptions {
  port: number;
  build: boolean;
  channelsFile?: string;
  theme: "light" | "dark";
  themeName: string;
}

function parseArgs(argv: string[]): RunOptions | null {
  const options: RunOptions = { port: 4319, build: true, theme: "light", themeName: "ember" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new CliError(`rome run: ${arg} needs a value`, 2);
      return next;
    };
    if (arg === "--help" || arg === "-h") return null;
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--no-build") options.build = false;
    // Resolved now: rome run moves into the app root before reading it.
    else if (arg === "--channels") options.channelsFile = resolve(value());
    else if (arg === "--theme") {
      const theme = value();
      if (theme !== "light" && theme !== "dark")
        throw new CliError("rome run: --theme is light or dark", 2);
      options.theme = theme;
    } else if (arg === "--theme-name") options.themeName = value();
    else throw new CliError(`rome run: unknown argument "${arg}"\n\n${HELP}`, 2);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535)
    throw new CliError("rome run: --port must be a port number", 2);
  return options;
}

export async function runRun(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (!options) {
    process.stdout.write(HELP);
    return;
  }

  const app = await readAppOnDisk(process.cwd());
  if (options.build) {
    process.chdir(app.appDir);
    await runBuild();
  }

  const actionNames: string[] = [];
  let warnedRoutines = false;
  const testApp = await createTestApp({
    appId: app.manifest.id,
    appVersion: app.manifest.version,
    description: app.manifest.description,
    tablePrefix: app.tablePrefix,
    ...(app.manifest.db
      ? { migrationsFolder: resolve(app.builtRoot, app.manifest.db.migrations) }
      : {}),
    channelHistory: options.channelsFile ? readChannelFile(options.channelsFile) : [],
    appContext: {
      // No routines exist outside Rome. An empty list keeps a UI that lists
      // them usable; the note says why it is empty.
      listRoutines: async () => {
        if (!warnedRoutines) {
          warnedRoutines = true;
          process.stderr.write("rome run: routines do not run here, so listRoutines returns []\n");
        }
        return [];
      },
    },
    unknownAction: async (name) => {
      // Only another app's or the system's actions are out of reach here. A
      // name of this app's that was never registered is a plain miss.
      if (!name.includes(":") || name.startsWith(`${app.manifest.id}:`)) {
        const prefixed = `${app.manifest.id}:${name}`;
        const hint =
          !name.includes(":") && actionNames.includes(name)
            ? `; Rome resolves this app's actions by full name, "${prefixed}"`
            : "";
        throw new ActionInvocationError(
          name,
          "not_found",
          `No action "${name}" in ${app.manifest.id}${hint}`,
        );
      }
      process.stderr.write(
        `rome run: ${name} is not available outside Rome; the caller got an error result\n`,
      );
      return { status: "error", error: `${name} is not available in rome run` };
    },
  });

  for (const { config, factory } of await loadActionModules(app)) {
    await testApp.action(config.name, factory, config);
    actionNames.push(config.name);
  }

  for (const entry of app.manifest.hooks ?? []) {
    const path = typeof entry === "string" ? entry : entry.path;
    // The host dispatches by public name: the entry's own, else the file name
    // without its extension (`defaultPublicName` in core's installer).
    const publicName =
      (typeof entry === "string" ? undefined : entry.publicName) ?? basename(path, extname(path));
    if (publicName !== "app-started") {
      process.stdout.write(`  hook ${path}: not delivered by rome run\n`);
      continue;
    }
    try {
      await testApp.start((await loadHookFactory(app, path)) as Parameters<TestApp["start"]>[0]);
      process.stdout.write(`  hook ${path}: ran\n`);
    } catch (err) {
      // The host logs an app-started failure and carries on; so does rome run.
      process.stderr.write(
        `  hook ${path}: threw ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const createApiHandler = (await loadApiFactory(app)) as
    | ((ctx: RomeAppContext) => RomeAppApiHandler)
    | null;

  const ctx: RunContext = { app, testApp, createApiHandler, options, actionNames };
  const server = createServer((req, res) => {
    // An unhandled rejection would end the process; one bad request must not.
    handleRunRequest(req, res, ctx).catch((err: unknown) => {
      process.stderr.write(`rome run: ${req.method} ${req.url} failed: ${String(err)}\n`);
      res.destroy();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolveListen);
  });

  const base = `http://127.0.0.1:${options.port}`;
  process.stdout.write(`
rome run: ${app.manifest.id}@${app.manifest.version}
  UI       ${app.manifest.web ? `${base}/apps/${appIdToPathSegment(app.manifest.id)}` : "(no web entry)"}
  API      ${createApiHandler ? `${base}/api/apps/${appIdToPathSegment(app.manifest.id)}/` : "(no api entry)"}
  actions  ${actionNames.join(", ") || "(none)"}
           curl -s -X POST ${base}/__rome/actions/<name> -d '{"args":{}}'
  state    ${base}/__rome
`);
  await new Promise<void>((done) => {
    // An open SSE or other streamed response would hold close() open.
    const stop = () => {
      server.close(() => done());
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  testApp.close();
}

/** What one `rome run` server answers from: the app on disk and its wired test app. */
export interface RunContext {
  app: AppOnDisk;
  testApp: TestApp;
  createApiHandler: ((ctx: RomeAppContext) => RomeAppApiHandler) | null;
  options: RunOptions;
  actionNames: string[];
}

/** Answer one request to a `rome run` server. Errors become a 500 with the message. */
export async function handleRunRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunContext,
): Promise<void> {
  try {
    await route(req, res, ctx);
  } catch (err) {
    // A client that closes a streamed response mid-way is not a failure.
    if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") return;
    if (err instanceof BadRequest && !res.headersSent) {
      return sendJson(res, 400, { error: err.message });
    }
    // The full error, stack included, goes to the terminal; the response
    // carries only its message.
    process.stderr.write(
      `rome run: ${req.method} ${req.url} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    // Once the body has started there is no status left to send.
    if (res.headersSent) return void res.destroy();
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : "request failed; see the rome run terminal",
    });
  }
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: RunContext): Promise<void> {
  // Every route acts as the guardian. Only this machine's own pages may call
  // them: a rebound DNS name fails the Host check, another site's page fails
  // the Origin check, and its cross-site GETs (which carry no Origin) fail the
  // Sec-Fetch-Site check. Another dev server on localhost counts as same-site.
  const local = [`127.0.0.1:${ctx.options.port}`, `localhost:${ctx.options.port}`];
  if (!local.includes(req.headers.host ?? "")) {
    return sendJson(res, 403, { error: `rome run only answers on ${local.join(" or ")}` });
  }
  const origin = req.headers.origin;
  if (origin && !local.some((host) => origin === `http://${host}`)) {
    return sendJson(res, 403, { error: `rome run does not answer pages from ${origin}` });
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return sendJson(res, 403, { error: `rome run does not answer ${fetchSite} requests` });
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // URLs carry the app id the way the host writes it: `@me/app` → `%40me%2Fapp`.
  const id = appIdToPathSegment(ctx.app.manifest.id);
  const path = url.pathname;

  if (path === "/" || path === "") return redirect(res, `/apps/${id}`);
  if (path === "/favicon.ico") return void res.writeHead(204).end();
  if (path === `/apps/${id}` || path.startsWith(`/apps/${id}/`)) return sendHostPage(res, ctx, url);
  if (path === "/__rome/host-themes.css") return sendFile(res, HOST_THEMES_CSS);
  if (path === "/__rome/host-mount.js") return sendFile(res, HOST_MOUNT_JS);
  if (path.startsWith(`/app-assets/${id}/`)) return sendAsset(res, ctx, path);
  if (path === `/api/apps/${id}` || path.startsWith(`/api/apps/${id}/`))
    return proxyApi(req, res, ctx, url);
  if (path.startsWith("/__rome")) return handleDev(req, res, ctx, path);
  sendJson(res, 404, { error: "not found" });
}

async function handleDev(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunContext,
  path: string,
): Promise<void> {
  const { testApp } = ctx;
  if (req.method === "GET" && path === "/__rome") {
    return sendJson(res, 200, {
      app: { id: ctx.app.manifest.id, version: ctx.app.manifest.version },
      actions: ctx.actionNames,
      settings: Object.fromEntries(testApp.settings),
      channels: { queries: testApp.channels.queries, sent: testApp.channels.sent },
      logs: testApp.logger.lines.length,
    });
  }
  if (req.method === "GET" && path === "/__rome/logs")
    return sendJson(res, 200, testApp.logger.lines);
  if (req.method === "GET" && path === "/__rome/channels") {
    return sendJson(res, 200, { queries: testApp.channels.queries, sent: testApp.channels.sent });
  }
  if (req.method === "POST" && path === "/__rome/channels") {
    const body = await readJson(req);
    const messages = (Array.isArray(body) ? body : [body]).map((value) =>
      toChannelMessage(value, (message) => new BadRequest(message)),
    );
    testApp.channels.push(...messages);
    return sendJson(res, 200, { added: messages.length });
  }
  const action = path.match(/^\/__rome\/actions\/(.+)$/);
  if (req.method === "POST" && action) {
    const body = (await readJson(req)) as
      | { args?: Record<string, unknown>; channel?: ThreadContext }
      | undefined;
    const name = decodeURIComponent(action[1]!);
    const run = () => testApp.runAction(name, body?.args ?? {});
    try {
      const result = body?.channel ? await testApp.inChannel(body.channel, run) : await run();
      return sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof ActionInvocationError && err.code === "not_found") {
        return sendJson(res, 404, { error: err.message, actions: ctx.actionNames });
      }
      throw err;
    }
  }
  sendJson(res, 404, { error: "not found" });
}

async function proxyApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunContext,
  url: URL,
): Promise<void> {
  if (!ctx.createApiHandler) return sendJson(res, 404, { error: "this app has no api entry" });
  const prefix = `/api/apps/${appIdToPathSegment(ctx.app.manifest.id)}`;
  const body = await readBody(req);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
  }
  // The host builds the handler per request; so does rome run.
  const response = await ctx.createApiHandler(ctx.testApp.appContext).handle({
    method: req.method ?? "GET",
    path: url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent),
    headers,
    query: url.searchParams,
    ...(body.length > 0 ? { body } : {}),
    caller: { kind: "guardian", userId: "guardian", via: "cookie" },
  });
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (!response.body) return void res.end();
  // Piped, not buffered, so a streamed response (SSE, progress) arrives as written.
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res);
}

function webDir(ctx: RunContext): string | null {
  const manifestPath = ctx.app.manifest.web?.manifest;
  return manifestPath ? dirname(resolve(ctx.app.builtRoot, manifestPath)) : null;
}

function sendAsset(res: ServerResponse, ctx: RunContext, path: string): void {
  const dir = webDir(ctx);
  // /app-assets/<id segment>/<version>/<file>
  const rest = path.split("/").slice(4).map(decodeURIComponent).join("/");
  if (!dir) return sendJson(res, 404, { error: "not found" });
  const file = resolve(dir, rest);
  const within = relative(dir, file);
  if (within.startsWith("..") || isAbsolute(within))
    return sendJson(res, 404, { error: "not found" });
  sendFile(res, file);
}

function sendHostPage(res: ServerResponse, ctx: RunContext, url: URL): void {
  const dir = webDir(ctx);
  if (!dir || !existsSync(join(dir, "manifest.json"))) {
    return sendJson(res, 404, { error: "this app has no built web bundle; run rome build" });
  }
  const webManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    entry: string;
    styles?: string[];
    assetVersion?: string;
  };
  const { id, version } = ctx.app.manifest;
  const segment = appIdToPathSegment(id);
  const assetBase = `/app-assets/${segment}/${webManifest.assetVersion ?? version}`;
  const theme =
    url.searchParams.get("theme") === "dark"
      ? "dark"
      : url.searchParams.get("theme") === "light"
        ? "light"
        : ctx.options.theme;
  const themeName = url.searchParams.get("themeName") ?? ctx.options.themeName;
  const routeBase = `/apps/${segment}`;
  const bootstrap = {
    appId: id,
    version,
    routeBase,
    routePath: url.pathname.slice(routeBase.length + 1),
    apiBase: `/api/apps/${segment}`,
    assetBase,
    shell: { locale: "en-US", theme, themeName, mode: "full" },
    caller: { kind: "guardian", userId: "guardian" },
  } satisfies RomeAppBootstrap;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    hostPage({
      title: ctx.app.manifest.web?.displayName ?? ctx.app.manifest.name ?? id,
      bootstrap,
      entryUrl: `${assetBase}/${webManifest.entry}`,
      styleUrls: (webManifest.styles ?? []).map((style) => `${assetBase}/${style}`),
    }),
  );
}

const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
const HOST_THEMES_CSS = join(ASSETS_DIR, "host-themes.css");
const HOST_MOUNT_JS = join(ASSETS_DIR, "host-mount.js");

/**
 * The dashboard's page host, reduced to what an app sees: the theme tokens on
 * <html>, a shadow root with the app canvas alias, the app's own CSS scoped
 * into it (`:root` → `:host`, relative urls resolved), and `mount(root,
 * bootstrap)`. Mirrors `prepareShadowMount` and `appendScopedStyles` in
 * packages/web/src/components/rome-app-host.tsx. The CSS handling lives in
 * assets/host-mount.js, which that component's test checks against it.
 */
function hostPage(input: {
  title: string;
  bootstrap: { shell: { theme: string; themeName: string } } & Record<string, unknown>;
  entryUrl: string;
  styleUrls: string[];
}): string {
  const { theme, themeName } = input.bootstrap.shell;
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(themeName)}" class="${theme === "dark" ? "dark" : ""}" style="color-scheme: ${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} · rome run</title>
<link rel="stylesheet" href="/__rome/host-themes.css">
<style>
  html, body { margin: 0; min-height: 100%; }
  body { background: var(--app-canvas); color: var(--foreground); font-family: ui-sans-serif, system-ui, sans-serif; }
  #rome-app-host { min-height: 100vh; }
  #rome-app-error { margin: 24px; padding: 16px; border: 1px solid var(--destructive); border-radius: 12px; white-space: pre-wrap; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<div id="rome-app-host"></div>
<script type="module">
import { PAGE_SHELL_CSS, scopeAppCss } from "/__rome/host-mount.js";
const bootstrap = ${json(input.bootstrap)};
const entryUrl = ${json(input.entryUrl)};
const styleUrls = ${json(input.styleUrls)};
try {
  const host = document.getElementById("rome-app-host");
  const shadow = host.attachShadow({ mode: "open" });
  const shell = document.createElement("style");
  shell.textContent = PAGE_SHELL_CSS;
  shadow.append(shell);
  for (const url of styleUrls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to load app stylesheet: " + response.status + " " + url);
    const style = document.createElement("style");
    style.textContent = scopeAppCss(await response.text(), new URL(url, location.href).toString());
    shadow.append(style);
  }
  const body = document.createElement("body");
  if (bootstrap.shell.theme === "dark") body.classList.add("dark");
  const root = document.createElement("div");
  root.id = "root";
  body.append(root);
  shadow.append(body);
  window.__ROME_APP_BOOTSTRAP__ = bootstrap;
  const mod = await import(entryUrl);
  if (typeof mod.mount !== "function") throw new Error("App bundle does not export mount(root, bootstrap)");
  await mod.mount(root, bootstrap);
} catch (err) {
  const box = document.createElement("pre");
  box.id = "rome-app-error";
  box.textContent = "Failed to mount the app: " + (err && err.stack || err);
  document.body.append(box);
  console.error(err);
}
</script>
</body>
</html>
`;
}

function readChannelFile(path: string): ChannelMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError(
      `rome run: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }
  if (!Array.isArray(parsed))
    throw new CliError(`rome run: ${path} must hold a JSON array of messages`, 2);
  return parsed.map((value) => toChannelMessage(value, (message) => new CliError(message, 2)));
}

let seededMessages = 0;

/** A seeded message from --channels or `POST /__rome/channels`. `fail` makes
 *  the error: a CLI exit for the file, a 400 for a request. */
function toChannelMessage(value: unknown, fail: (message: string) => Error): ChannelMessage {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof raw.channel !== "string" || typeof raw.text !== "string") {
    throw fail("rome run: every channel message needs a channel and a text");
  }
  const timestamp = raw.timestamp === undefined ? new Date() : new Date(String(raw.timestamp));
  if (Number.isNaN(timestamp.getTime())) {
    throw fail(
      `rome run: channel message timestamp ${JSON.stringify(raw.timestamp)} is not a date`,
    );
  }
  return {
    direction: "inbound",
    messageId: `seed_${++seededMessages}`,
    conversationId: "conversation",
    senderId: "sender",
    attachments: [],
    ...raw,
    channel: raw.channel,
    text: raw.text,
    timestamp,
  } as unknown as ChannelMessage;
}

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => done(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", fail);
  });
}

/** A request `rome run` refuses as malformed, answered with a 400. */
class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch (err) {
    throw new BadRequest(`request body is not JSON: ${(err as Error).message}`);
  }
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function sendFile(res: ServerResponse, file: string): void {
  if (!existsSync(file) || !statSync(file).isFile())
    return sendJson(res, 404, { error: "not found" });
  res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("location", location);
  res.end();
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}
