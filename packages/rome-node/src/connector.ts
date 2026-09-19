import { randomUUID } from "node:crypto";
import {
  actionError,
  isRecord,
  parseResponse,
  type ActionRequest,
  type ActionResponse,
} from "./actions.js";
import { connectGateway, type ConnectionStatus } from "./client.js";
import { cloudRequest, CloudError, gatewayConfig } from "./cloud.js";
import { byteLength, MAX_MESSAGE_BYTES, validId, type GatewayMessage } from "./protocol.js";
import { createNodeSocket } from "./socket.js";
import type { CallerCredential } from "./local.js";

export interface DeviceConnectorOptions {
  credential: CallerCredential;
  connect?: typeof connectGateway;
  waitMs?: number;
}

export class DeviceConnector {
  private connection?: ReturnType<typeof connectGateway>;
  private initializing?: Promise<void>;
  private status: ConnectionStatus = "stopped";
  private stopped = false;
  private pending = new Map<string, { target: string; finish(response: ActionResponse): void }>();
  private ready = new Set<() => void>();

  constructor(private options: DeviceConnectorOptions) {}

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
      onStatus: (status) => {
        this.status = status;
        if (status !== "online") {
          for (const pending of this.pending.values())
            pending.finish(
              actionError(
                "unknown_outcome",
                "The connection was lost. Execution may have occurred. Do not automatically retry.",
              ),
            );
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
    if (!pending) return;
    if ("type" in message) {
      pending.finish(actionError(message.code, "The Gateway could not forward the request."));
      return;
    }
    if (message.from !== pending.target) return;
    const response = parseResponse(message.payload);
    if (response) pending.finish(response);
  }

  async run(target: string, action: string, args: unknown): Promise<ActionResponse> {
    if (!validId(target) || !action || action.length > 128)
      return actionError("invalid_request", "A device ID and action are required.");
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
    if (this.pending.size >= 128)
      return actionError("busy", "Too many device requests are pending.");
    const id = randomUUID();
    const envelope = {
      id,
      to: target,
      payload: { type: "request", action, args } satisfies ActionRequest,
    };
    try {
      if (byteLength(JSON.stringify(envelope)) > MAX_MESSAGE_BYTES)
        return actionError("message_too_large", "The request exceeds 128 KiB.");
    } catch {
      return actionError("invalid_request", "Action arguments must be JSON.");
    }
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
        this.options.waitMs ?? 60_000,
      );
      this.pending.set(id, { target, finish });
      if (!this.connection?.send(envelope))
        finish(
          actionError(
            "unknown_outcome",
            "The request could not be submitted reliably. Do not automatically retry.",
          ),
        );
    });
  }

  stop() {
    this.stopped = true;
    this.connection?.stop();
    for (const pending of this.pending.values())
      pending.finish(
        actionError(
          "unknown_outcome",
          "The CLI daemon is shutting down. Execution may have occurred.",
        ),
      );
    for (const wake of this.ready) wake();
  }
}
