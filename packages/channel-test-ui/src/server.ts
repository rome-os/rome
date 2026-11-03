import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

/** What to run: every scenario, or the tests named exactly by `names`. */
export interface RunTarget {
  names?: string[];
}

export interface ServeOptions {
  /** The directory the scenarios write traces and `index.json` into. */
  traces: string;
  /** The built browser UI. */
  web: string;
  port: number;
  /** The command that runs scenarios with traces on for `target`. */
  command(target: RunTarget): { command: string; args: string[]; cwd: string };
  /** A source tree whose changes start a full run, as in a watch mode. */
  watch?: string;
}

interface RunState {
  running: boolean;
  /** The last lines the latest run printed. */
  log: string[];
  exitCode?: number | null;
}

const LOG_LINES = 200;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/**
 * Serves the browser UI and the traces under `options.traces`, pushes a
 * server-sent event whenever `index.json` changes or a run starts or ends, and
 * runs the scenarios on request. One run at a time: a request while one is
 * running is refused. Development only; nothing in Rome's runtime mounts it.
 */
export function serve(options: ServeOptions) {
  mkdirSync(options.traces, { recursive: true });
  const clients = new Set<ServerResponse>();
  const state: RunState = { running: false, log: [] };
  // A source change during a run asks for one more full run once it ends.
  let rerunQueued = false;

  const broadcast = (event: string, data: unknown) => {
    for (const client of clients)
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const run = (target: RunTarget): boolean => {
    if (state.running) return false;
    if (!target.names?.length) {
      // A full run starts the index over, so deleted tests drop out of it.
      rmSync(join(options.traces, "index.json"), { force: true });
      rmSync(join(options.traces, "traces"), { recursive: true, force: true });
    }
    const { command, args, cwd } = options.command(target);
    Object.assign(state, { running: true, log: [], exitCode: undefined });
    broadcast("run", state);
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer) => {
      state.log.push(...chunk.toString().split("\n").filter(Boolean));
      state.log.splice(0, Math.max(0, state.log.length - LOG_LINES));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => {
      Object.assign(state, { running: false, exitCode: code });
      broadcast("run", state);
      if (rerunQueued) {
        rerunQueued = false;
        run({});
      }
    });
    return true;
  };

  const indexChanged = debounced(() => broadcast("index", {}));
  const sourceChanged = debounced(() => {
    if (!run({})) rerunQueued = true;
  });
  const watchers = [
    watch(options.traces, (_, file) => {
      if (file === "index.json") indexChanged();
    }),
  ];
  if (options.watch) {
    watchers.push(
      watch(options.watch, { recursive: true }, (_, file) => {
        if (file && !file.includes("node_modules")) sourceChanged();
      }),
    );
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: run\ndata: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/index") {
      const file = join(options.traces, "index.json");
      return sendJson(res, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
    }
    if (req.method === "GET" && url.pathname === "/api/trace") {
      const file = inside(options.traces, url.searchParams.get("path") ?? "");
      if (!file || !existsSync(file)) return notFound(res);
      return sendJson(res, JSON.parse(readFileSync(file, "utf8")));
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      // A cross-site page cannot send this content type without a preflight,
      // which this server never answers, so only the UI can start a run.
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return sendJson(res, { error: "Send application/json" }, 415);
      const target = JSON.parse((await readBody(req)) || "{}") as RunTarget;
      if (!run(target)) return sendJson(res, { error: "A run is in progress" }, 409);
      return sendJson(res, state, 202);
    }
    if (req.method === "GET") return sendStatic(res, options.web, url.pathname);
    return notFound(res);
  }

  server.listen(options.port, "127.0.0.1");
  return {
    server,
    run,
    close() {
      for (const watcher of watchers) watcher.close();
      for (const client of clients) client.end();
      server.close();
    },
  };
}

/** `fire` once things go quiet, however many calls came in a burst. */
function debounced(fire: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fire, 150);
  };
}

/** `child` resolved under `root`, or null when it would leave `root`. */
function inside(root: string, child: string): string | null {
  const file = resolve(root, child);
  return file.startsWith(resolve(root) + sep) ? file : null;
}

function sendStatic(res: ServerResponse, root: string, path: string) {
  const file = inside(root, path.slice(1) || "index.html");
  // Every route the UI owns serves its single page.
  const target = file && existsSync(file) && extname(file) ? file : join(root, "index.html");
  if (!existsSync(target))
    return notFound(res, "Build the UI first: pnpm --filter @rome/channel-test-ui build:web");
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
  });
  res.end(readFileSync(target));
}

function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function notFound(res: ServerResponse, message = "Not found") {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end(message);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}
