import type { DevicesStatus } from "./devices-status.js";
import {
  actionError,
  isRecord,
  parseResponse,
  type ActionResponse,
  type BinaryActionResult,
} from "./actions.js";
import { validId } from "./protocol.js";
import { isUuid } from "./frame.js";
import {
  MAX_LOCAL_MESSAGE_BYTES,
  parseDaemonStatus,
  type DaemonStatus,
  type ConnectionEvent,
  type CopyProgress,
  type CopyRequest,
  type CopySummary,
} from "./daemon-protocol.js";
import { isAbsolute } from "node:path";
import {
  DaemonRequestError,
  DaemonVersionError,
  RpcError,
  type RpcConnection,
} from "./daemon-rpc.js";
import { ensureDaemon, findDaemon } from "./daemon-control.js";
import type { NodeConfig } from "./local.js";

export {
  createNodeConfig,
  nodeConfigFromEnvironment,
  readOptionalCallerCredential,
  CallerConfigurationError,
  type NodeConfig,
  type CallerCredential,
} from "./local.js";
export { daemonStatus, startDaemon, stopDaemon } from "./daemon-control.js";
export { DaemonRequestError, DaemonVersionError } from "./daemon-rpc.js";
export type {
  DaemonStatus,
  ConnectionEvent,
  CopyProgress,
  CopyRequest,
  CopySummary,
} from "./daemon-protocol.js";
export type { DevicesStatus, DeviceStatus } from "./devices-status.js";
export type { ActionResponse, BinaryActionResult } from "./actions.js";

export class DeviceActionError extends Error {
  readonly code: string;
  constructor(readonly response: Extract<ActionResponse, { ok: false }>) {
    super(response.error.message);
    this.code = response.error.code;
  }
}

export interface DeviceList {
  items: Array<{ id: string; [key: string]: unknown }>;
}
export interface NodeClientOptions {
  onListenerError?(error: unknown): void;
}
interface Observer {
  listener(event: ConnectionEvent): void;
  seen?: RpcConnection;
}

/** Owns one local WebSocket. Disconnecting never stops the shared daemon or cancels remote work. */
export function createNodeClient(config: NodeConfig, options: NodeClientOptions = {}) {
  let closed = false;
  let incompatible = false;
  let connection: RpcConnection | undefined;
  let connecting: Promise<RpcConnection | null> | undefined;
  const lifetime = new AbortController();
  const observers = new Set<Observer>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const assertOpen = () => {
    if (closed) throw new Error("The caller client is closed.");
  };
  function emit(event: ConnectionEvent, rpc?: RpcConnection) {
    for (const observer of observers) {
      observer.seen = rpc;
      try {
        observer.listener(event);
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
  }
  function scheduleReconnect() {
    if (closed || incompatible || !observers.size || retry || connection) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        // Reconnect to an existing daemon. A watcher must not restart an explicitly stopped service.
        void connect(false)
          .catch(() => {})
          .finally(scheduleReconnect);
      },
      Math.min(5000, 250 * 2 ** Math.min(attempt++, 5)),
    );
  }
  async function initialize(start: boolean): Promise<RpcConnection | null> {
    let owned: RpcConnection | undefined;
    try {
      const found = await (start
        ? ensureDaemon(config, lifetime.signal)
        : findDaemon(config, lifetime.signal));
      if (!found) return null;
      const { rpc } = found;
      owned = rpc;
      if (closed || !rpc.open) {
        rpc.close();
        throw new DaemonRequestError();
      }
      connection = rpc;
      rpc.onNotification = (method, params) => {
        if (connection !== rpc || closed || method !== "events.connection") return;
        const status = parseDaemonStatus(params);
        if (!status) {
          rpc.close();
          return;
        }
        emit({ transport: "connected", daemon: status }, rpc);
      };
      rpc.onClose = () => {
        if (connection !== rpc) return;
        connection = undefined;
        if (!closed) {
          emit({ transport: "disconnected", daemon: null, reason: "connection_lost" });
          scheduleReconnect();
        }
      };
      if (observers.size) await rpc.request("events.subscribe", { topic: "connection" }, 5000);
      attempt = 0;
      return rpc;
    } catch (error) {
      owned?.close();
      if (error instanceof DaemonVersionError && !closed) {
        incompatible = true;
        emit({ transport: "disconnected", daemon: null, reason: "incompatible" });
      }
      throw error;
    }
  }
  async function connect(start: boolean): Promise<RpcConnection | null> {
    assertOpen();
    if (incompatible) throw new DaemonVersionError();
    if (connection?.open && !connecting) return connection;
    if (connecting) {
      const result = await connecting;
      return result || !start ? result : connect(true);
    }
    connecting = initialize(start).finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  async function call(method: string, params?: unknown) {
    const rpc = await connect(true);
    assertOpen();
    if (!rpc) throw new DaemonRequestError();
    return rpc.request(method, params);
  }
  async function run(
    deviceId: string,
    action: string,
    args: unknown = {},
  ): Promise<ActionResponse> {
    assertOpen();
    if (!validId(deviceId) || typeof action !== "string" || !action || action.length > 128)
      return actionError("invalid_request", "A device ID and action are required.");
    let body: unknown;
    try {
      body = JSON.parse(JSON.stringify({ deviceId, action, args }));
    } catch {
      return actionError("invalid_request", "Action arguments must be JSON.");
    }
    try {
      const response = parseResponse(await call("devices.run", body));
      return (
        response ??
        actionError(
          "unknown_outcome",
          "The action response was invalid. Do not automatically retry.",
        )
      );
    } catch (error) {
      if (error instanceof DaemonRequestError) return actionError(error.code, error.message);
      if (error instanceof RpcError)
        return actionError(
          error.code === -32602 ? "invalid_request" : "gateway_unavailable",
          error.message,
        );
      throw error;
    }
  }
  async function runBinary(
    deviceId: string,
    action: string,
    args: unknown = {},
    body: Uint8Array = new Uint8Array(),
  ): Promise<BinaryActionResult> {
    assertOpen();
    const empty = new Uint8Array();
    const failure = (code: string, message: string) => ({
      response: actionError(code, message),
      body: empty,
    });
    if (!isUuid(deviceId) || typeof action !== "string" || !action || action.length > 128)
      return failure("invalid_request", "A device UUID and action are required.");
    let params: unknown;
    let size: number;
    try {
      const text = JSON.stringify({ deviceId, action, args });
      params = JSON.parse(text);
      size = Buffer.byteLength(text);
    } catch {
      return failure("invalid_request", "Action arguments must be JSON.");
    }
    // The envelope adds well under 1 KiB to the params and body.
    if (size + body.byteLength + 1024 > MAX_LOCAL_MESSAGE_BYTES)
      return failure("invalid_request", "The input exceeds the 64 MiB local message limit.");
    try {
      const rpc = await connect(true);
      assertOpen();
      if (!rpc) throw new DaemonRequestError();
      const reply = await rpc.requestBinary("devices.runBinary", params, body);
      const response = parseResponse(reply.result);
      if (!response)
        return failure(
          "unknown_outcome",
          "The action response was invalid. Do not automatically retry.",
        );
      return { response, body: response.ok ? reply.body : empty };
    } catch (error) {
      if (error instanceof DaemonRequestError) return failure(error.code, error.message);
      if (error instanceof RpcError)
        return failure(
          error.code === -32602 ? "invalid_request" : "gateway_unavailable",
          error.message,
        );
      throw error;
    }
  }
  async function copy(
    request: CopyRequest,
    options: { onProgress?(progress: CopyProgress): void } = {},
  ): Promise<CopySummary> {
    assertOpen();
    const failure = (code: string, message: string) =>
      new DeviceActionError({ type: "response", ok: false, error: { code, message } });
    if (
      (request.direction !== "push" && request.direction !== "pull") ||
      typeof request.localPath !== "string" ||
      !isAbsolute(request.localPath) ||
      !isUuid(request.deviceId) ||
      typeof request.remotePath !== "string" ||
      !request.remotePath
    )
      throw failure(
        "invalid_request",
        "A copy needs direction push or pull, an absolute localPath, a device UUID, and remotePath.",
      );
    const { direction, localPath, deviceId, remotePath } = request;
    let value: unknown;
    try {
      const rpc = await connect(true);
      assertOpen();
      if (!rpc) throw new DaemonRequestError();
      // A copy has no total wait limit. The daemon aborts it after 60 seconds without progress.
      value = await rpc.request(
        "files.copy",
        { direction, localPath, deviceId, remotePath },
        Number.POSITIVE_INFINITY,
        (params) => {
          if (typeof params.bytes === "number" && typeof params.total === "number")
            options.onProgress?.({ bytes: params.bytes, total: params.total });
        },
      );
    } catch (error) {
      if (error instanceof DaemonRequestError) throw failure(error.code, error.message);
      if (error instanceof RpcError)
        throw failure(
          error.code === -32602 ? "invalid_request" : "gateway_unavailable",
          error.message,
        );
      throw error;
    }
    const response = parseResponse(value);
    if (!response)
      throw failure("unknown_outcome", "The copy response was invalid. Run the copy again.");
    if (!response.ok) throw new DeviceActionError(response);
    const summary = response.result;
    if (
      !isRecord(summary) ||
      typeof summary.bytes !== "number" ||
      typeof summary.ms !== "number" ||
      typeof summary.sha256 !== "string"
    )
      throw failure("unknown_outcome", "The copy response was invalid. Run the copy again.");
    return { bytes: summary.bytes, ms: summary.ms, sha256: summary.sha256 };
  }
  return {
    async getConnectionStatus(): Promise<DaemonStatus | null> {
      const rpc = await connect(false);
      if (!rpc) return null;
      const status = parseDaemonStatus(await rpc.request("daemon.status", {}, 5000));
      if (!status) throw new Error("Invalid caller daemon status.");
      return status;
    },
    /** Probes devices through an existing daemon. Returns null without starting one if absent. */
    async getDevicesStatus(): Promise<DevicesStatus | null> {
      let body: unknown;
      try {
        const rpc = await connect(false);
        if (!rpc) return null;
        body = await rpc.request("devices.status");
      } catch (error) {
        if (error instanceof RpcError && error.code === -32601) throw new DaemonVersionError();
        throw error;
      }
      if (
        !isRecord(body) ||
        !Array.isArray(body.devices) ||
        typeof body.checkedAt !== "string" ||
        !["stopped", "connecting", "online", "retrying", "revoked", "superseded"].includes(
          String(body.connection),
        ) ||
        !body.devices.every(
          (device) =>
            isRecord(device) &&
            typeof device.id === "string" &&
            typeof device.name === "string" &&
            (device.platform === null || typeof device.platform === "string") &&
            ["connected", "not_connected", "unknown", "revoked"].includes(String(device.status)),
        )
      )
        throw new Error("Invalid devices status response.");
      return body as unknown as DevicesStatus;
    },
    async listDevices(): Promise<DeviceList> {
      let body: unknown;
      try {
        body = await call("devices.list");
      } catch (error) {
        if (error instanceof RpcError)
          throw new DeviceActionError({
            type: "response",
            ok: false,
            error: { code: "gateway_unavailable", message: error.message },
          });
        throw error;
      }
      if (
        !isRecord(body) ||
        !Array.isArray(body.items) ||
        !body.items.every((item) => isRecord(item) && typeof item.id === "string")
      )
        throw new Error("Invalid device list response.");
      return body as unknown as DeviceList;
    },
    run,
    /**
     * Runs an action with `body` as input bytes and returns its output bytes, for example exec
     * stdin and stdout. Neither side is JSON-encoded. Failure semantics match run.
     */
    runBinary,
    /**
     * Copies one file between this computer and a device, in the direction given. Resolves after
     * both sides verified size and SHA-256, and throws DeviceActionError otherwise. A failed copy
     * leaves the destination unchanged and can be run again. `onProgress` receives about four
     * updates per second. Disconnecting the client aborts the copy.
     */
    copy,
    describe: (deviceId: string) => run(deviceId, "system.info"),
    /** Delivers a snapshot before resolving, then changes. Reconnection delivers a fresh snapshot, not history. */
    async subscribe(
      topic: "connection",
      listener: (event: ConnectionEvent) => void,
    ): Promise<() => Promise<void>> {
      assertOpen();
      if (topic !== "connection") throw new Error("Unknown event topic.");
      const observer: Observer = { listener };
      observers.add(observer);
      try {
        const rpc = await connect(true);
        if (!rpc) throw new DaemonRequestError();
        if (observer.seen !== rpc) await rpc.request("events.subscribe", { topic }, 5000);
      } catch (error) {
        observers.delete(observer);
        if (!observers.size) {
          clearTimeout(retry);
          retry = undefined;
        }
        throw error;
      }
      return async () => {
        if (!observers.delete(observer) || observers.size) return;
        clearTimeout(retry);
        retry = undefined;
        if (connection?.open) await connection.request("events.unsubscribe", { topic }, 5000);
      };
    },
    disconnect() {
      if (closed) return;
      closed = true;
      clearTimeout(retry);
      observers.clear();
      lifetime.abort();
      connection?.close();
      connection = undefined;
    },
  };
}
