// Forwards a console client's JSON-RPC to the local daemon. Rome Core and Desktop main both
// put this between a browser WebSocket and the daemon, because a browser cannot send the
// daemon's Authorization header. Design record: rome-os/rome#1031.
import { isRecord } from "./actions.js";
import { findDaemon } from "./daemon-control.js";
import { DaemonVersionError, RpcError, type RpcConnection } from "./daemon-rpc.js";
import { readOptionalCallerCredential, type NodeConfig } from "./local.js";

/** Largest console client message, in bytes. */
export const MAX_CONSOLE_MESSAGE_BYTES = 64 * 1024;

/** Why the console has no daemon. Sent as `console.daemon` right before the bridge closes. */
export type ConsoleDaemonState = "not_configured" | "not_running" | "incompatible" | "disconnected";

export interface ConsoleTransport {
  send(text: string): void;
  /** Called once. The client reconnects later, then fills its gap with log.query. */
  close(): void;
}

export interface ConsoleBridge {
  /** Handles one text message from the console client. */
  receive(text: string): void;
  close(): void;
}

const READ_METHODS = new Set(["node.status", "log.query", "log.stats"]);

/**
 * Opens a bridge to the daemon of `config` without starting one. Only the observation methods
 * pass: node.status, log.query, log.stats, and events.subscribe or events.unsubscribe on the
 * `node` topic.
 * Responses and `events.node` notifications reach the client in daemon order.
 */
export function openConsoleBridge(config: NodeConfig, transport: ConsoleTransport): ConsoleBridge {
  let closed = false;
  let rpc: RpcConnection | undefined;
  const queued: string[] = [];
  const lifetime = new AbortController();
  const finish = (state?: ConsoleDaemonState) => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    if (state)
      transport.send(
        JSON.stringify({ jsonrpc: "2.0", method: "console.daemon", params: { state } }),
      );
    rpc?.close();
    transport.close();
  };
  const reply = (
    id: unknown,
    body: { result: unknown } | { error: { code: number; message: string } },
  ) => {
    if (!closed) transport.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  };

  function forward(text: string) {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      reply(null, { error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (
      !isRecord(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      (typeof message.id !== "string" && typeof message.id !== "number")
    ) {
      reply(null, { error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const { id, method } = message;
    const params = message.params ?? {};
    const allowed =
      READ_METHODS.has(method) ||
      ((method === "events.subscribe" || method === "events.unsubscribe") &&
        isRecord(params) &&
        params.topic === "node");
    if (!allowed) {
      reply(id, { error: { code: -32601, message: "Method not found" } });
      return;
    }
    rpc!.request(method, params, 15_000).then(
      (result) => reply(id, { result }),
      (error: unknown) =>
        reply(id, {
          error:
            error instanceof RpcError
              ? { code: error.code, message: error.message }
              : { code: -32000, message: "The rome-node daemon did not answer." },
        }),
    );
  }

  void (async () => {
    try {
      const found = await findDaemon(config, lifetime.signal);
      if (closed) {
        found?.rpc.close();
        return;
      }
      if (!found) {
        finish((await readOptionalCallerCredential(config)) ? "not_running" : "not_configured");
        return;
      }
      rpc = found.rpc;
      rpc.onNotification = (method, params) => {
        if (method === "events.node" && !closed)
          transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      };
      rpc.onClose = () => finish("disconnected");
      for (const text of queued.splice(0)) forward(text);
    } catch (error) {
      if (closed) return;
      finish(error instanceof DaemonVersionError ? "incompatible" : "not_running");
    }
  })();

  return {
    receive(text) {
      if (closed) return;
      if (Buffer.byteLength(text) > MAX_CONSOLE_MESSAGE_BYTES) {
        finish();
        return;
      }
      if (rpc) forward(text);
      else if (queued.length < 16) queued.push(text);
      else finish();
    },
    close: () => finish(),
  };
}
