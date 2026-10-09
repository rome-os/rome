import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

// Captured before any test stubs the global, so a peer that is itself
// installed as `globalThis.fetch` still reaches its own socket.
const nativeFetch = globalThis.fetch.bind(globalThis);

/** A request as a peer's route sees it. */
export interface PeerRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: Record<string, unknown>;
  /** Aborted when the client goes away or the peer closes; long polls wait on it. */
  signal: AbortSignal;
}

/**
 * A peer's answer. `source` says where the body's shape came from: a reviewed
 * capture, or a hand-written stand-in for a case no capture covers yet.
 */
export interface Reply {
  status?: number;
  body: unknown;
  source: "capture" | "synthetic";
  /** The route changed what the platform shows: a message created or edited. */
  accepted?: boolean;
}

/** One request the peer received and what became of it, in arrival order. */
export interface PeerExchange {
  request: { method: string; path: string; body: Record<string, unknown> };
  /** Absent while the route runs, and when a fault dropped the response. */
  response?: { status: number; body: unknown };
  source?: Reply["source"] | "fault";
  accepted: boolean;
  /** The platform applied the request, but the client never got the answer. */
  dropped?: boolean;
}

/**
 * A fault for the next request matching `method` and `path`. `before` holds the
 * request until it resolves; `respond` answers without running the route;
 * `dropAfterAccept` runs the route and then cuts the socket, so the platform
 * changed but the client cannot know.
 */
export interface Fault {
  method: string;
  path: string;
  before?: () => Promise<void>;
  respond?: { status: number; body: unknown };
  dropAfterAccept?: boolean;
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

/** Holds a request until the test releases it, instead of guessing a sleep. */
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

/**
 * A strict loopback HTTP server standing in for a platform API. A request no
 * route answers is a test failure, never a guess: it is recorded in `errors`,
 * answered 418, and `assertClean()` throws.
 */
export class PeerServer {
  readonly exchanges: PeerExchange[] = [];
  readonly errors: string[] = [];
  private readonly faults: Fault[] = [];
  private readonly controllers = new Set<AbortController>();
  private readonly waiters = new Set<() => void>();
  private origin = "";
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch((error: unknown) => {
      this.errors.push(String(error));
      // 418: no platform answers with it and no SDK retries it, so the test
      // fails once, on the request at fault.
      if (!res.headersSent)
        res
          .writeHead(418, { "content-type": "application/json" })
          .end(JSON.stringify({ error: String(error) }));
      else res.destroy();
    });
  });

  private readonly sockets = new WebSocketServer({ noServer: true });

  /**
   * `route` answers HTTP requests. `onSocket` takes each WebSocket a client
   * opens on the peer; without it, an upgrade is an unmodeled request.
   */
  constructor(
    private readonly route: (
      request: PeerRequest,
    ) => Promise<Reply | undefined> | Reply | undefined,
    onSocket?: (socket: WebSocket, path: string) => void,
  ) {
    this.server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", this.url).pathname;
      if (!onSocket) {
        this.errors.push(`Unmodeled WebSocket: ${path}`);
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (client) => onSocket(client, path));
    });
  }

  /** The `ws:` URL of `path` on this peer. */
  socketUrl(path: string): string {
    return `${this.url.replace("http:", "ws:")}${path}`;
  }

  async start(): Promise<this> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Peer has no port");
    this.origin = `http://127.0.0.1:${address.port}`;
    return this;
  }

  get url(): string {
    if (!this.origin) throw new Error("Peer has not started");
    return this.origin;
  }

  once(fault: Fault): void {
    this.faults.push(fault);
  }

  /** A fetch that reaches only this peer, for SDK transport seams. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== this.url) throw new Error(`Peer blocked a request to ${url.origin}`);
    return nativeFetch(input, { ...init, redirect: "error" });
  };

  /** Resolves with the first exchange matching `predicate`, now or later. */
  waitFor(
    predicate: (exchange: PeerExchange) => boolean,
    timeoutMs = 3_000,
  ): Promise<PeerExchange> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.exchanges.find(predicate);
        if (!found) return;
        cleanup();
        resolve(found);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`No matching request within ${timeoutMs} ms. ${this.errors.join("; ")}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  /** Throws if a request went unanswered or a scripted fault never fired. */
  assertClean(): void {
    if (this.errors.length) throw new Error(this.errors.join("\n"));
    if (this.faults.length) throw new Error(`${this.faults.length} scripted faults never fired`);
  }

  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    for (const client of this.sockets.clients) client.terminate();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private changed() {
    for (const waiter of [...this.waiters]) waiter();
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const controller = new AbortController();
    this.controllers.add(controller);
    res.on("close", () => {
      controller.abort();
      this.controllers.delete(controller);
    });

    const url = new URL(req.url ?? "/", this.url);
    const method = req.method ?? "GET";
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const body = parseBody(await readBody(req), headers.get("content-type"));

    const exchange: PeerExchange = {
      request: { method, path: url.pathname, body },
      accepted: false,
    };
    this.exchanges.push(exchange);
    this.changed();

    const index = this.faults.findIndex((f) => f.method === method && f.path === url.pathname);
    const fault = index < 0 ? undefined : this.faults.splice(index, 1)[0];
    if (fault?.before) {
      await Promise.race([fault.before(), once(controller.signal, "abort")]);
      if (controller.signal.aborted) return;
    }

    let status: number;
    let answer: unknown;
    if (fault?.respond) {
      ({ status, body: answer } = fault.respond);
      exchange.source = "fault";
    } else {
      const reply = await this.route({
        method,
        path: url.pathname,
        query: url.searchParams,
        headers,
        body,
        signal: controller.signal,
      });
      if (!reply) throw new Error(`Unmodeled request: ${method} ${url.pathname}`);
      status = reply.status ?? 200;
      answer = reply.body;
      exchange.source = reply.source;
      exchange.accepted = reply.accepted === true;
    }

    if (fault?.dropAfterAccept) {
      exchange.dropped = true;
      this.changed();
      res.destroy();
      return;
    }
    exchange.response = { status, body: answer };
    this.changed();
    if (res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024 * 1024) throw new Error("Request body exceeds 16 MiB");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer, contentType: string | null): Record<string, unknown> {
  if (!raw.length) return {};
  if (!contentType?.includes("application/json"))
    throw new Error(`Unmodeled request content type: ${contentType}`);
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

/** A message as the platform would show it to someone in the conversation. */
export interface VisibleMessage {
  id: string;
  conversation: string;
  from: "rome" | "user";
  text: string;
  replyTo?: string;
  /** How many times the text was edited after the message was created. */
  edits: number;
}

/** What a platform holds, independent of how its API spells it. */
export class MessageStore {
  private readonly messages = new Map<string, VisibleMessage>();

  add(message: Omit<VisibleMessage, "edits">): VisibleMessage {
    const stored = { ...message, edits: 0 };
    this.messages.set(message.id, stored);
    return stored;
  }

  get(id: string): VisibleMessage | undefined {
    return this.messages.get(id);
  }

  edit(id: string, text: string): VisibleMessage {
    const message = this.messages.get(id);
    if (!message) throw new Error(`No message ${id}`);
    message.text = text;
    message.edits += 1;
    return message;
  }

  /** The conversation's messages in the order they were created. */
  visible(conversation: string): VisibleMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.conversation === conversation)
      .map((message) => ({ ...message }));
  }
}

/** A platform stand-in: an API server plus what the platform shows. */
export interface Peer {
  readonly server: PeerServer;
  visible(conversation: string): VisibleMessage[];
  close(): Promise<void>;
}
