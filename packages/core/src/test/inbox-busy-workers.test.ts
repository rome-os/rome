// A burst of messages from more chats than Rome has action workers, through
// the Inbox app's channel-message hook and the real action engine: each
// message waits for a worker and is answered once, rather than failing.

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  ActionEngineLike,
  Channel,
  ChatId,
  ChatSettingsControl,
  ChatStopHandler,
  InboundEvent,
} from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";
import { ChannelMessageHook } from "../../../../rome_apps/inbox/src/hooks/channel-message/index.js";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import type { ActionResult } from "../apps/actions/types.js";
import { createActionEngineRepos } from "./db.js";
import { buildAction } from "./kit/index.js";

/** The cap the scored run logged ("max 16 live workers"). */
const MAX_WORKERS = 16;
const CHATS = 24;
const CONNECTION_ID = "connection:slack-app";

/** How many turns are running at once, and the most there ever were. */
const inFlight = { now: 0, peak: 0 };

/** An action worker that answers only when told to, as a slow turn does. */
class SlowWorker extends EventEmitter {
  pid = 1;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly runs: Array<{ messageId: string }> = [];
  private pending = 0;

  send(message: unknown, cb?: (err: Error | null) => void): boolean {
    cb?.(null);
    const sent = message as { type?: string; actionName?: string; args?: { messageId: string } };
    if (sent.type === "shutdown") {
      this.connected = false;
      this.exitCode = 0;
      queueMicrotask(() => this.emit("exit", 0, null));
    } else if (sent.actionName === "message_handler" && sent.args) {
      this.runs.push({ messageId: sent.args.messageId });
      this.pending += 1;
      inFlight.now += 1;
      inFlight.peak = Math.max(inFlight.peak, inFlight.now);
    }
    return true;
  }

  finish(): boolean {
    if (this.pending === 0) return false;
    this.pending -= 1;
    inFlight.now -= 1;
    this.emit("message", { type: "result", result: { status: "ok", data: "answered" } });
    return true;
  }
}

function snapshot(connectionId: string, chatId: ChatId) {
  return {
    conversation: {
      ref: { connectionId, chatId },
      connectionKind: "slack_app",
      service: "slack_app",
      kind: "dm" as const,
      displayName: chatId,
    },
    supportedFields: [],
    effective: {
      enabled: true,
      activation: {
        mode: "all" as const,
        botMessages: "ignore" as const,
        whenOthersMentioned: "ignore" as const,
      },
      replies: { placement: "inline" as const },
      routing: { agentName: null },
      session: { reset: { mode: "idle" as const, idleMinutes: 10_080 } },
    },
    overrides: {},
  };
}

describe("Inbox when every action worker is busy", () => {
  it(`answers each of ${CHATS} direct messages from distinct chats once, at ${MAX_WORKERS} workers`, async () => {
    const workers: SlowWorker[] = [];
    const registry = new ActionRegistryImpl();
    registry.register(buildAction("message_handler"));
    const engine = new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      workerWarmPoolSize: 0,
      maxWorkerProcesses: MAX_WORKERS,
      actionWorkerFork: () => {
        const worker = new SlowWorker();
        workers.push(worker);
        return worker as unknown as ChildProcess;
      },
      // The host running the tests has no say over the queue.
      memoryHeadroom: () => null,
    });

    const settled: Array<ActionResult | Error> = [];
    const actionEngine: ActionEngineLike = {
      run: (name, args, context) =>
        engine.run(name, args, context).then(
          (result) => {
            settled.push(result);
            return result;
          },
          (error: Error) => {
            settled.push(error);
            throw error;
          },
        ),
    };

    let handler: ((event: InboundEvent) => Promise<void>) | undefined;
    const channel: Channel = {
      name: "slack_app",
      send: { send: async (chatId) => ({ chatId }) },
      inbound: {
        subscribe: (subscribed) => {
          handler = subscribed;
          return () => {};
        },
        media: null,
      },
    };
    const chatSettings = {
      get: async ({ connectionId, chatId }: { connectionId: string; chatId: ChatId }) =>
        snapshot(connectionId, chatId),
    } as unknown as ChatSettingsControl;
    const chatStop: ChatStopHandler = async () => ({ status: "stop_requested", turnId: "t" });
    const hook = new ChannelMessageHook(actionEngine, chatSettings, chatStop, [channel], {});
    await hook.register();

    // The whole backlog drains at once, one message in each chat.
    const delivered = Array.from({ length: CHATS }, (_, i) =>
      handler!({
        kind: "message",
        ref: { connectionId: CONNECTION_ID, chatId: `D${i}` as ChatId },
        message: {
          channel: "slack_app",
          direction: "inbound",
          messageId: `m${i}`,
          chatId: `D${i}` as ChatId,
          senderId: "U1",
          text: `message ${i}`,
          attachments: [],
          timestamp: new Date(Date.UTC(2026, 10, 19, 12, 0, i)),
          thread: { kind: "dm", name: "U1" },
        },
      }),
    );
    await Promise.all(delivered);

    // Turns finish one at a time while the rest wait.
    await rs.waitFor(() => expect(workers.length).toBeGreaterThan(0));
    await rs.waitFor(
      () => {
        for (const worker of workers) worker.finish();
        expect(settled).toHaveLength(CHATS);
      },
      { timeout: 10_000, interval: 5 },
    );

    expect(settled.filter((outcome) => outcome instanceof Error)).toEqual([]);
    const ran = workers.flatMap((worker) => worker.runs.map((run) => run.messageId));
    expect(ran.sort()).toEqual(Array.from({ length: CHATS }, (_, i) => `m${i}`).sort());
    // The cap held, so some messages waited for a worker rather than running.
    expect(inFlight.peak).toBeLessThanOrEqual(MAX_WORKERS);
    expect(inFlight.peak).toBeLessThan(CHATS);
  });
});
