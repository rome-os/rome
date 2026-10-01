// JSON-RPC 2.0 stdio client for `codex app-server`.
//
// Transport the CodexAppServerProvider needs: we spawn `codex app-server` (via
// the shared codex CLI launcher in ./cli.ts) and frame JSON-RPC over its
// stdin/stdout (newline-delimited JSON, the stdio:// default). Responsibilities:
// request/response id correlation,
// notification dispatch, and answering server→client requests (approvals —
// which with approvalPolicy:"never" should never fire, but we answer
// defensively). See KEEP-INTURN-TEXT-RESEARCH.md §6.

import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createLogger } from "../../logger.js";
import { spawnCodexAppServer } from "./cli.js";
import type {
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./app-server-protocol.js";

const log = createLogger("codex-app-server");

export interface AppServerClientOptions {
  cwd: string;
  env: Record<string, string>;
  /** Root `-c key=value` overrides passed to `codex` before `app-server`. */
  configArgs?: readonly string[];
  /** Fired for every server→client notification. */
  onNotification: (method: string, params: unknown) => void;
  /** Fired for server→client requests; the resolved value becomes the JSON-RPC
   *  result. Throwing yields a JSON-RPC error response. */
  onServerRequest: (method: string, params: unknown) => Promise<unknown> | unknown;
  /** Fired when the subprocess exits unexpectedly. */
  onExit?: (code: number | null) => void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class AppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private stdoutBuf = "";
  private closed = false;
  private exited = false;

  constructor(private readonly opts: AppServerClientOptions) {}

  start(): void {
    log.info("spawning codex app-server");
    const proc = spawnCodexAppServer(
      {
        cwd: this.opts.cwd,
        env: this.opts.env,
      },
      this.opts.configArgs,
    );
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) log.debug("app-server stderr", { text: text.slice(0, 500) });
    });
    proc.stdin.on("error", (err) => this.handleTransportExit(err, null));
    proc.on("exit", (code) => {
      this.handleTransportExit(new Error(`codex app-server exited (code ${code ?? "null"})`), code);
    });
    proc.on("error", (err) => {
      this.handleTransportExit(err, null);
    });
  }

  /** Issue a request and resolve with its `result` (or reject on error). */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error("app-server client is closed"));
    // After exit no response can ever arrive; registering the request in
    // `pending` would leave the caller waiting forever.
    if (this.exited) return Promise.reject(new Error("codex app-server exited"));
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(payload);
    });
  }

  /** Fire a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed || this.exited || !this.proc) return;
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.write(payload);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("app-server client closed");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  private write(msg: unknown): void {
    const proc = this.proc;
    if (!proc || this.closed || this.exited || proc.stdin.destroyed || !proc.stdin.writable) {
      if (!this.closed && !this.exited) {
        this.handleTransportExit(new Error("codex app-server stdin is not writable"), null);
      }
      return;
    }
    try {
      proc.stdin.write(JSON.stringify(msg) + "\n", (err) => {
        if (err) this.handleTransportExit(err, null);
      });
    } catch (err) {
      this.handleTransportExit(err instanceof Error ? err : new Error(String(err)), null);
    }
  }

  private handleTransportExit(err: Error, code: number | null): void {
    if (this.closed || this.exited) return;
    this.exited = true;
    log.warn("codex app-server transport exited", { code, error: err.message });
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    this.opts.onExit?.(code);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcRequest & JsonRpcResponse & JsonRpcNotification;
      try {
        msg = JSON.parse(line);
      } catch {
        log.debug("non-JSON line from app-server", { line: line.slice(0, 200) });
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcRequest & JsonRpcResponse & JsonRpcNotification): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    // Server→client request: has both id and method.
    if (hasId && typeof msg.method === "string") {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    // Response to one of our requests: has id, no method.
    if (hasId) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error)
        pending.reject(
          new AppServerRpcError(msg.error.message || "app-server error", msg.error.code),
        );
      else pending.resolve(msg.result);
      return;
    }
    // Notification: method, no id.
    if (typeof msg.method === "string") {
      try {
        this.opts.onNotification(msg.method, msg.params);
      } catch (err) {
        log.error("notification handler threw", {
          method: msg.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.opts.onServerRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
