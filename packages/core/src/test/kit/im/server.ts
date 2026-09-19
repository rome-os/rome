import { createServer, type ServerResponse } from "node:http";
import { EventEmitter, once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";

export interface FixtureRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: Record<string, unknown>;
  files: Array<{ field: string; name: string; bytes: Uint8Array }>;
  signal: AbortSignal;
}

export interface FixtureResponse {
  /** True only when the route applied a message mutation or upload. */
  accepted?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FixtureCall {
  method: string;
  path: string;
  body: unknown;
  files: Array<{ field: string; name: string; size: number }>;
  startedAt: number;
  completedAt?: number;
  accepted: boolean;
  status?: number;
  dropped?: boolean;
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Explicit request barrier: tests release work rather than guessing a sleep duration. */
export function requestBarrier() {
  const entered = deferred();
  const released = deferred();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /token|secret|authorization/i.test(key) ? "[redacted]" : redact(item),
    ]),
  );
}

interface Fault {
  method: string;
  path: string;
  before?: () => Promise<void>;
  response?: FixtureResponse;
  dropAfterAccept?: boolean;
}

/** A strict, loopback-only HTTP/WS peer. Unhandled routes are failures, never proxy requests. */
export class ImFixtureServer {
  readonly calls: FixtureCall[] = [];
  readonly errors: string[] = [];
  readonly ws = new WebSocketServer({ noServer: true });
  private faults: Fault[] = [];
  private controllers = new Set<AbortController>();
  private origin = "";
  private changes = new EventEmitter();
  private server = createServer((req, res) => {
    void this.handle(req, res).catch((error) => {
      this.errors.push(String(error));
      if (!res.destroyed) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
  });

  constructor(
    private readonly route: (
      request: FixtureRequest,
    ) => Promise<FixtureResponse | undefined> | FixtureResponse | undefined,
  ) {
    this.server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url!, this.url).pathname !== "/gateway") {
        this.errors.push("Unexpected WebSocket path");
        socket.destroy();
        return;
      }
      this.ws.handleUpgrade(req, socket, head, (peer) => this.ws.emit("connection", peer, req));
    });
  }

  get url() {
    if (!this.origin) throw new Error("Fixture server has not started");
    return this.origin;
  }
  get gatewayUrl() {
    return this.url.replace("http:", "ws:") + "/gateway";
  }

  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    this.origin = `http://127.0.0.1:${address.port}`;
    return this;
  }

  once(fault: Fault) {
    this.faults.push(fault);
  }

  waitForCall(predicate: (call: FixtureCall) => boolean, timeoutMs = 3000): Promise<FixtureCall> {
    const existing = this.calls.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.changes.off("change", check);
        this.changes.off("close", closed);
      };
      const check = () => {
        const call = this.calls.find(predicate);
        if (call) {
          cleanup();
          resolve(call);
        }
      };
      const closed = () => {
        cleanup();
        reject(new Error("Fixture closed while awaiting a request"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Expected fixture request did not arrive. ${this.errors.join("; ")}`));
      }, timeoutMs);
      this.changes.on("change", check);
      this.changes.on("close", closed);
    });
  }

  /** Pass to SDK HTTP seams; redirects cannot escape to the Internet. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== this.url) throw new Error(`Fixture blocked external origin: ${url.origin}`);
    try {
      return await fetch(input, { ...init, redirect: "error" });
    } catch (error) {
      // Socket drops are scripted outcomes; failed request construction is a fixture defect.
      if (error instanceof TypeError && !(error as Error & { cause?: unknown }).cause)
        this.errors.push(String(error));
      throw error;
    }
  };

  assertClean() {
    if (this.errors.length) throw new Error(this.errors.join("\n"));
    if (this.faults.length)
      throw new Error(`${this.faults.length} scripted faults were not consumed`);
  }

  async close() {
    this.changes.emit("close");
    for (const controller of this.controllers) controller.abort();
    for (const peer of this.ws.clients) peer.terminate();
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async handle(req: import("node:http").IncomingMessage, res: ServerResponse) {
    const controller = new AbortController();
    this.controllers.add(controller);
    res.on("close", () => {
      controller.abort();
      this.controllers.delete(controller);
    });
    const url = new URL(req.url!, this.url);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error("Fixture request exceeds 16 MiB");
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    const body: Record<string, unknown> = {};
    const files: FixtureRequest["files"] = [];
    if (headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await new Response(raw, { headers }).formData();
      for (const [field, value] of form.entries()) {
        if (typeof value === "string") body[field] = value;
        else
          files.push({ field, name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
    } else if (headers.get("content-type")?.includes("application/octet-stream")) {
      files.push({ field: "body", name: "upload", bytes: raw });
    } else if (raw.length) Object.assign(body, JSON.parse(raw.toString()));
    if (typeof body.payload_json === "string") Object.assign(body, JSON.parse(body.payload_json));
    const call: FixtureCall = {
      method: req.method!,
      path: url.pathname.replace(/\/bot[^/]+\//, "/bot[redacted]/"),
      body: redact(body),
      files: files.map(({ field, name, bytes }) => ({ field, name, size: bytes.length })),
      startedAt: Date.now(),
      accepted: false,
    };
    this.calls.push(call);
    this.changes.emit("change");
    const faultIndex = this.faults.findIndex(
      (f) => f.method === req.method && f.path === url.pathname,
    );
    const fault = faultIndex < 0 ? undefined : this.faults.splice(faultIndex, 1)[0];
    if (fault?.before) {
      await Promise.race([
        fault.before(),
        new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (controller.signal.aborted) return;
    }
    const response =
      fault?.response ??
      (await this.route({
        method: req.method!,
        path: url.pathname,
        query: url.searchParams,
        headers,
        body,
        files,
        signal: controller.signal,
      }));
    if (!response) throw new Error(`Unmodeled fixture request: ${call.method} ${call.path}`);
    call.status = response.status ?? 200;
    call.accepted = !fault?.response && response.accepted === true;
    call.completedAt = Date.now();
    this.changes.emit("change");
    if (fault?.dropAfterAccept) {
      call.dropped = true;
      res.destroy();
      return;
    }
    if (res.destroyed) return;
    res.writeHead(call.status, { "content-type": "application/json", ...response.headers });
    res.end(JSON.stringify(response.body ?? {}));
  }
}

export function sendJson(peer: WebSocket, value: unknown) {
  peer.send(JSON.stringify(value));
}
