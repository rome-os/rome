import { randomUUID } from "node:crypto";
import {
  actionError,
  isRecord,
  parseResponse,
  type ActionRequest,
  type ActionResponse,
  type BinaryActionResult,
} from "./actions.js";
import { connectGateway, type ConnectionStatus } from "./client.js";
import { cloudRequest, CloudError, gatewayConfig } from "./cloud.js";
import {
  decodeMeta,
  encodeMeta,
  FRAME_TYPE,
  frameFits,
  isUuid,
  MAX_FRAME_BYTES,
  type Frame,
} from "./frame.js";
import { validId, type GatewayMessage } from "./protocol.js";
import { createNodeSocket } from "./socket.js";
import type { CallerCredential } from "./local.js";
import type { ChannelEvents, TransferChannel } from "./transfer.js";

/** Most requests and channels the connector keeps pending at once. */
const MAX_PENDING = 128;

export interface DeviceConnectorOptions {
  credential: CallerCredential;
  connect?: typeof connectGateway;
  waitMs?: number;
  onStatus?(status: ConnectionStatus): void;
}

export class DeviceConnector {
  private connection?: ReturnType<typeof connectGateway>;
  private initializing?: Promise<void>;
  private status: ConnectionStatus = "stopped";
  private stopped = false;
  private pending = new Map<
    string,
    { target: string; binary: boolean; finish(response: ActionResponse, body?: Uint8Array): void }
  >();
  private ready = new Set<() => void>();
  private channels = new Map<string, { target: string; events: ChannelEvents }>();

  constructor(private options: DeviceConnectorOptions) {}

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private async ensure(): Promise<void> {
    if (this.stopped || this.status === "superseded" || this.status === "revoked")
      throw new Error("connector_stopped");
    if (this.connection) return;
    // Concurrent commands must finish initialization before a second socket can open.
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  private async initialize(): Promise<void> {
    const { cloudUrl, token } = this.options.credential;
    const gatewayUrl = await gatewayConfig(cloudUrl, token);
    if (this.stopped) throw new Error("connector_stopped");
    this.connection = (this.options.connect ?? connectGateway)({
      gatewayUrl,
      deviceToken: token,
      createSocket: createNodeSocket,
      beforeConnect: async () => {
        try {
          return await gatewayConfig(cloudUrl, token);
        } catch (error) {
          if (error instanceof CloudError && error.code === "invalid_device_session") return null;
          throw error;
        }
      },
      onMessage: (message) => this.receive(message),
      onFrame: (frame) => this.receiveFrame(frame),
      onStatus: (status) => {
        this.status = status;
        this.options.onStatus?.(status);
        if (status !== "online") {
          for (const pending of this.pending.values())
            pending.finish(
              actionError(
                "unknown_outcome",
                "The connection was lost. Execution may have occurred. Do not automatically retry.",
              ),
            );
          for (const channel of [...this.channels.values()]) channel.events.lost();
        }
        for (const wake of this.ready) wake();
      },
    });
  }

  async list(): Promise<unknown> {
    if (this.stopped) throw new Error("connector_stopped");
    const { cloudUrl, token } = this.options.credential;
    const body = await cloudRequest(cloudUrl, "/api/account/devices", token);
    if (!isRecord(body) || !Array.isArray(body.items)) throw new CloudError("invalid_response");
    return { items: body.items };
  }

  private receive(message: GatewayMessage) {
    const pending = this.pending.get(message.id);
    if (!pending || pending.binary) return;
    if ("type" in message) {
      pending.finish(actionError(message.code, "The Gateway could not forward the request."));
      return;
    }
    if (message.from !== pending.target) return;
    const response = parseResponse(message.payload);
    if (response) pending.finish(response);
  }

  private receiveFrame(frame: Frame) {
    const channel = this.channels.get(frame.id);
    if (channel) {
      if (frame.peer !== channel.target) return;
      if (frame.type === FRAME_TYPE.response)
        channel.events.frame(decodeMeta(frame.meta), frame.body);
      else if (frame.type === FRAME_TYPE.routeError) {
        const meta = decodeMeta(frame.meta);
        channel.events.frame(
          actionError(
            isRecord(meta) && typeof meta.code === "string" ? meta.code : "target_unavailable",
            "The Gateway could not forward the request.",
          ),
          new Uint8Array(),
        );
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending?.binary || frame.peer !== pending.target) return;
    if (frame.type === FRAME_TYPE.routeError) {
      const meta = decodeMeta(frame.meta);
      pending.finish(
        actionError(
          isRecord(meta) && typeof meta.code === "string" ? meta.code : "target_unavailable",
          "The Gateway could not forward the request.",
        ),
      );
      return;
    }
    if (frame.type !== FRAME_TYPE.response) return;
    const response = parseResponse(decodeMeta(frame.meta));
    if (response) pending.finish(response, frame.body);
  }

  /** Returns null when the connection is online and has capacity, otherwise the failure. */
  private async admit(): Promise<ActionResponse | null> {
    try {
      await this.ensure();
    } catch {
      return actionError("gateway_unavailable", "The device connection is unavailable.");
    }
    if (this.status !== "online")
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.ready.delete(wake);
          resolve();
        };
        const wake = () => {
          if (["online", "revoked", "superseded", "stopped"].includes(this.status)) finish();
        };
        const timer = setTimeout(finish, 10_000);
        this.ready.add(wake);
        wake();
      });
    if (this.status !== "online")
      return actionError(
        "gateway_unavailable",
        "The device connection is offline. No operation was sent.",
      );
    return null;
  }

  /**
   * Requests and channels share one cap. Callers check it synchronously right before
   * registering, because any await between the check and the registration lets a burst pass it.
   */
  private full(): ActionResponse | null {
    return this.pending.size + this.channels.size >= MAX_PENDING
      ? actionError("busy", "Too many device requests are pending.")
      : null;
  }

  async run(
    target: string,
    action: string,
    args: unknown,
    waitMs = this.options.waitMs ?? 60_000,
  ): Promise<ActionResponse> {
    if (!validId(target) || !action || action.length > 128)
      return actionError("invalid_request", "A device ID and action are required.");
    const refused = await this.admit();
    if (refused) return refused;
    const id = randomUUID();
    const envelope = {
      id,
      to: target,
      payload: { type: "request", action, args } satisfies ActionRequest,
    };
    try {
      JSON.stringify(envelope);
    } catch {
      return actionError("invalid_request", "Action arguments must be JSON.");
    }
    const busy = this.full();
    if (busy) return busy;
    return new Promise((resolve) => {
      const finish = (response: ActionResponse) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(response);
      };
      const timer = setTimeout(
        () =>
          finish(
            actionError(
              "unknown_outcome",
              "The local wait limit was reached. The remote program was not canceled. Do not automatically retry.",
            ),
          ),
        waitMs,
      );
      this.pending.set(id, { target, binary: false, finish });
      if (!this.connection?.send(envelope))
        finish(
          actionError(
            "unknown_outcome",
            "The request could not be submitted reliably. Do not automatically retry.",
          ),
        );
    });
  }

  /** Sends the request as a binary frame with `body` as input bytes. Outcome semantics match run. */
  async runBinary(
    target: string,
    action: string,
    args: unknown,
    body: Uint8Array,
    waitMs = this.options.waitMs ?? 60_000,
  ): Promise<BinaryActionResult> {
    const empty = new Uint8Array();
    if (!isUuid(target) || !action || action.length > 128)
      return {
        response: actionError("invalid_request", "A device UUID and action are required."),
        body: empty,
      };
    let meta: Uint8Array;
    try {
      meta = encodeMeta({ type: "request", action, args } satisfies ActionRequest);
    } catch {
      return {
        response: actionError("invalid_request", "Action arguments must be JSON."),
        body: empty,
      };
    }
    if (!frameFits(meta.byteLength, body.byteLength))
      return {
        response: actionError(
          "message_too_large",
          `The input does not fit in one ${MAX_FRAME_BYTES / 1024 / 1024} MiB frame. Nothing was sent. Use rome-node cp for large files.`,
        ),
        body: empty,
      };
    const refused = await this.admit();
    if (refused) return { response: refused, body: empty };
    const busy = this.full();
    if (busy) return { response: busy, body: empty };
    const id = randomUUID();
    const peer = target.toLowerCase();
    return new Promise((resolve) => {
      const finish = (response: ActionResponse, output: Uint8Array = empty) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ response, body: response.ok ? output : empty });
      };
      const timer = setTimeout(
        () =>
          finish(
            actionError(
              "unknown_outcome",
              "The local wait limit was reached. The remote program was not canceled. Do not automatically retry.",
            ),
          ),
        waitMs,
      );
      this.pending.set(id, { target: peer, binary: true, finish });
      if (!this.connection?.sendFrame({ type: FRAME_TYPE.request, id, peer, meta, body }))
        finish(
          actionError(
            "unknown_outcome",
            "The request could not be submitted reliably. Do not automatically retry.",
          ),
        );
    });
  }

  /**
   * Opens a frame channel to `target`. Every frame sent on it carries one channel ID, and response
   * and route error frames with that ID from `target` go to `events` until close. Connection loss
   * calls `events.lost`. Returns a failed ActionResponse when the connection is unavailable.
   */
  async openChannel(
    target: string,
    events: ChannelEvents,
  ): Promise<(TransferChannel & { id: string }) | ActionResponse> {
    if (!isUuid(target)) return actionError("invalid_request", "A device UUID is required.");
    const refused = await this.admit();
    if (refused) return refused;
    const busy = this.full();
    if (busy) return busy;
    const id = randomUUID();
    const peer = target.toLowerCase();
    this.channels.set(id, { target: peer, events });
    return {
      id,
      send: (meta, body = new Uint8Array()) => {
        if (!this.channels.has(id)) return false;
        try {
          return (
            this.connection?.sendFrame({
              type: FRAME_TYPE.request,
              id,
              peer,
              meta: encodeMeta(meta),
              body,
            }) ?? false
          );
        } catch {
          return false;
        }
      },
      close: () => {
        this.channels.delete(id);
      },
    };
  }

  stop() {
    this.stopped = true;
    this.status = "stopped";
    if (this.connection) this.connection.stop();
    else this.options.onStatus?.("stopped");
    for (const pending of this.pending.values())
      pending.finish(
        actionError("unknown_outcome", "The caller is shutting down. Execution may have occurred."),
      );
    for (const wake of this.ready) wake();
  }
}
