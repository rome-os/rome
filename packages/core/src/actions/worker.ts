import { context, propagation } from "@opentelemetry/api";
import { isIpcMessage, getWorkerIpc } from "./ipc.js";
import {
  initTelemetry,
  recordActionWorkerStartup,
  shutdown as shutdownTelemetry,
} from "../telemetry.js";
import {
  isActionWorkerPayload,
  isActionWorkerShutdown,
  type ActionWorkerMessage,
  type ActionWorkerPayload,
} from "./worker-protocol.js";
import { createWorkerActionEngine } from "./worker-runtime.js";
import type { ActionEngine } from "./engine.js";
import { createLogger } from "../logger.js";

const log = createLogger("action-worker");

// Bound on `shutdownTelemetry()` so a degraded OTLP collector (e.g.
// `rome-obs` restarting) doesn't leave each worker lingering for the
// BatchSpanProcessor's 30s default flush timeout. 5s is generous for a
// same-Docker-network OTLP flush; anything slower than that means obs is
// down and dropping the queued spans is the right call.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

async function sendMessage(message: ActionWorkerMessage): Promise<void> {
  if (process.send) {
    await new Promise<void>((resolve) => process.send!(message, () => resolve()));
  }
}

async function sendThenExit(message: ActionWorkerMessage, exitCode: number): Promise<void> {
  await sendMessage(message);
  // Flush the BatchSpanProcessor before exiting; without this, spans created
  // during the action body (`agent:*`, `model.turn`, etc.) sit in the queue
  // and are dropped when the worker terminates.
  await Promise.race([
    shutdownTelemetry(),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
  ]);
  process.exit(exitCode);
}

async function shutdownAndExit(exitCode: number): Promise<void> {
  await Promise.race([
    shutdownTelemetry(),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
  ]);
  process.exit(exitCode);
}

async function runUnderParentTrace(
  engine: ActionEngine,
  payload: ActionWorkerPayload,
): Promise<ActionWorkerMessage> {
  const result = await engine.run(payload.actionName, payload.args, payload.context, {
    onRuntimeEvent: (event) => {
      process.send?.({
        type: "runtime_event",
        event,
      } satisfies ActionWorkerMessage);
    },
  });
  return { type: "result", result };
}

async function runPayload(engine: ActionEngine, payload: ActionWorkerPayload): Promise<void> {
  // Restore the parent's W3C trace context so spans created in this worker
  // chain back to the `action:*` span in the main process.
  const parentCtx = propagation.extract(context.active(), payload.traceCarrier ?? {});
  const message = await context.with(parentCtx, async () => {
    // Record the fork → body cold-start under the restored parent trace, so the
    // `worker.startup` span nests beside the action body in the waterfall.
    recordActionWorkerStartup(payload.forkStartedAt, payload.actionName, Date.now());
    return runUnderParentTrace(engine, payload);
  });
  await sendMessage(message);
}

let enginePromise: Promise<ActionEngine> | null = null;
let running = false;

// Eagerly initialize the worker-side IpcRpc so it attaches its process.on
// listener before the first call into main lands.
getWorkerIpc();

function getEngine(): Promise<ActionEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      initTelemetry();
      const engine = await createWorkerActionEngine();
      await sendMessage({ type: "ready" });
      return engine;
    })();
  }
  return enginePromise;
}

void getEngine().catch((err) => {
  sendThenExit(
    {
      type: "error",
      error:
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: "Error", message: String(err) },
    },
    1,
  ).catch(() => process.exit(1));
});

process.once("disconnect", () => {
  void shutdownAndExit(0);
});

process.on("message", (message: unknown) => {
  // IpcRpc messages are handled by the singleton IpcRpc instance via
  // its own process.on("message") listener; ignore them here.
  if (isIpcMessage(message)) {
    return;
  }
  if (isActionWorkerShutdown(message)) {
    void shutdownAndExit(0);
    return;
  }
  if (!isActionWorkerPayload(message)) {
    log.warn("ignoring unexpected message", { pid: process.pid, message });
    return;
  }
  if (running) {
    void sendMessage({
      type: "error",
      error: { name: "Error", message: "Action worker is already running an action" },
    });
    return;
  }
  running = true;
  getEngine()
    .then((engine) => runPayload(engine, message))
    .catch((err) =>
      sendMessage({
        type: "error",
        error:
          err instanceof Error
            ? { name: err.name, message: err.message }
            : { name: "Error", message: String(err) },
      }),
    )
    .finally(() => {
      running = false;
    });
});
