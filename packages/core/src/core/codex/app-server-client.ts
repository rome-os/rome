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
  /** Fired once, with the cause, when the subprocess exits or its pipe breaks before close(). */
  onExit?: (error: Error) => void;
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
  /** Why the transport ended, once it has; later requests reject with it. */
  private exitError: Error | null = null;

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
    proc.stdin.on("error", (err) => this.handleTransportError(err));
    proc.on("exit", (code, signal) => {
      const status = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
      this.handleTransportExit(new Error(`codex app-server exited (${status})`), { code, signal });
    });
    proc.on("error", (err) => this.handleTransportError(err));
  }

  /** Issue a request and resolve with its `result` (or reject on error). */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error("app-server client is closed"));
    // After exit no response can ever arrive; registering the request in
    // `pending` would leave the caller waiting forever.
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(payload);
    });
  }

  /** Fire a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed || this.exitError || !this.proc) return;
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
    if (!proc || this.closed || this.exitError || proc.stdin.destroyed || !proc.stdin.writable) {
      if (!this.closed && !this.exitError) {
        this.handleTransportError(new Error("stdin is not writable"));
      }
      return;
    }
    try {
      proc.stdin.write(JSON.stringify(msg) + "\n", (err) => {
        if (err) this.handleTransportError(err);
      });
    } catch (err) {
      this.handleTransportError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleTransportError(err: Error): void {
    this.handleTransportExit(new Error(`codex app-server connection failed: ${err.message}`));
  }

  private handleTransportExit(
    err: Error,
    exit?: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    if (this.closed) return;
    if (this.exitError) {
      // Callers keep the first cause. A broken pipe usually comes before the
      // exit that caused it, so log that exit to tell a crash from a restart.
      if (exit) {
        log.warn("codex app-server exited after its connection failed", {
          ...exit,
          firstCause: this.exitError.message,
        });
      }
      return;
    }
    this.exitError = err;
    log.warn("codex app-server transport exited", { ...exit, error: err.message });
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    this.opts.onExit?.(err);
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
