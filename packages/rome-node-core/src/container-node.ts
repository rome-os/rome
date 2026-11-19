import { CloudError, cloudOrigin, gatewayConfig } from "./cloud.js";
import { connectGateway, type ConnectionStatus } from "./client.js";
import { containerNodeOrigin } from "./container-node-address.js";
import { createContainerNodeResponder } from "./container-node-responder.js";
import { isUuid } from "./frame.js";
import { createNodeSocket } from "./socket.js";

type Exit = "stopped" | "revoked" | "superseded";

export async function runContainerNode(options: {
  origin: string;
  deviceToken: string;
  callerId?: string;
  signal: AbortSignal;
  onStatus?(status: ConnectionStatus): void;
}): Promise<Exit> {
  const { deviceToken, callerId, signal } = options;
  const origin =
    callerId === undefined ? cloudOrigin(options.origin) : containerNodeOrigin(options.origin);
  if (
    !/^romedev_[A-Za-z0-9_-]{43}$/.test(deviceToken) ||
    (callerId !== undefined && !isUuid(callerId))
  )
    throw new Error("Invalid container node credentials.");
  if (signal.aborted) return "stopped";

  const directHttp = callerId !== undefined && origin.startsWith("http:");
  return new Promise<Exit>((resolve) => {
    const responder = createContainerNodeResponder(
      "Container node",
      callerId?.toLowerCase(),
      (message) => connection.send(message),
      (frame) => connection.sendFrame(frame),
    );
    let finished = false;
    const finish = (result: Exit) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      responder.disconnect();
      connection.stop();
      void responder.idle().then(() => resolve(result));
    };
    const abort = () => finish("stopped");

    const connection = connectGateway(
      {
        getToken: () => deviceToken,
        createSocket: createNodeSocket,
        async beforeConnect() {
          try {
            return await gatewayConfig(origin, deviceToken, directHttp);
          } catch (error) {
            if (error instanceof CloudError && error.code === "invalid_device_session") return null;
            throw error;
          }
        },
        onMessage(message) {
          if ("from" in message) void responder.receive(message);
        },
        onFrame: (frame) => void responder.receiveFrame(frame),
        onStatus(status) {
          if (finished) return;
          options.onStatus?.(status);
          if (status === "revoked" || status === "superseded") finish(status);
          else if (status === "retrying") responder.disconnect();
        },
      },
      directHttp ? origin : undefined,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
