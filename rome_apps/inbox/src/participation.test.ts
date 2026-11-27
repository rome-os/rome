/**
 * Pins what Inbox does with the wake gate's answer, and that the agent's reply
 * goes out. One row is one case: change a row only when the behavior is meant
 * to change.
 *
 * The gate's own table lives with it in packages/core/src/participation: which
 * policy and settings wake the agent (chat-settings-wake.test.ts).
 */
import { describe, expect, it, rs } from "@rstest/core";
import type {
  ActionConfig,
  ActionEngineLike,
  AgentMessage,
  AgentRunnerInterface,
  Channel,
  ChatId,
  ChatSettingsControl,
  InboundEvent,
  MessagesSaid,
  RunParams,
  SaidInboundEvent,
} from "@rome-os/app-runtime";
import type { WakeGate } from "./actions/message-handler/index.js";
import { createAction } from "./actions/message-handler/index.js";
import { ChannelMessageHook } from "./hooks/channel-message/index.js";

const actionConfig: ActionConfig = {
  name: "inbox:message_handler",
  type: "system",
  description: "Handle incoming messages",
  complexity: "moderate",
  speed: "moderate",
  reliability: "high",
  sideEffects: "write",
};

interface Setup {
  /** What Core's wake gate answers, `wake` when absent. */
  wake?: ReturnType<WakeGate>;
  /** The hook's decision passed on with the message, so Inbox asks no gate. */
  decidedByHook?: "wake";
  /** What each agent answers, in the order they run. */
  answers?: AgentMessage[][];
  /** The host recorded the message before Inbox heard it, as it does when it
   *  hands the hook `messagesSaid`. */
  recorded?: boolean;
  /** Where the message was said: a direct message, or a group (the default). */
  threadType?: "private" | "group";
}

function result(content: string): AgentMessage {
  return { type: "result", content };
}

/** Runs one message through `inbox:message_handler` and reports what it did. */
async function handle(setup: Setup) {
  const runs: RunParams[] = [];
  const answers = setup.answers ?? [];
  const agentRunner: AgentRunnerInterface = {
    async *run(params: RunParams): AsyncIterable<AgentMessage> {
      const index = runs.length;
      runs.push(params);
      for (const message of answers[index] ?? []) yield message;
    },
    hasAgent: () => true,
    hasAction: () => false,
  };
  const stored: { role: string }[] = [];
  const promoted: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const wakeRequests: Parameters<WakeGate>[] = [];

  const action = createAction(actionConfig, {
    agentRunner,
    wakeGateFor:
      async () =>
      (...request: Parameters<WakeGate>) => {
        wakeRequests.push(request);
        return setup.wake ?? "wake";
      },
    appContext: {
      repositories: {
        chats: {
          ensureChannelChat: async () => ({ id: "chat-1", agentName: null }),
          addMessage: async (message: { role: string }) => {
            stored.push(message);
            return { inserted: true };
          },
          promoteMessageToUser: async (_chatId: string, messageId: string) => {
            promoted.push(messageId);
          },
        },
      },
      runAction: async (_name: string, args: Record<string, unknown>) => {
        sent.push(args);
        return { status: "ok" };
      },
    },
    resolveProfilePath: (filePath: string) => `/nonexistent/${filePath}`,
  } as unknown as Parameters<typeof createAction>[1]);

  const outcome = await action.execute({
    connectionId: "connection:telegram",
    channel: "telegram",
    channelUserId: "user-1",
    threadId: "chat-1",
    threadName: "Dev Chat",
    threadType: setup.threadType ?? "group",
    displayName: "Alice",
    text: "Can you help?",
    messageId: "message-1",
    ...(setup.recorded ? { recordedMessageId: "recorded-1" } : {}),
    ...(setup.decidedByHook ? { wake: setup.decidedByHook } : {}),
  });

  return { outcome, runs, stored, promoted, sent, wakeRequests };
}

type Wake = "woke" | "quiet" | "blocked";

/** The wake decision as a caller sees it: which agent ran first, if any. */
function wakeOf(handled: Awaited<ReturnType<typeof handle>>): Wake {
  const data = handled.outcome.data as { action?: string } | undefined;
  if (data?.action === "blocked") return "blocked";
  if (data?.action === "ignored_by_reply_settings") return "quiet";
  if (handled.runs[0]?.agentName === "main") return "woke";
  throw new Error(`unexpected handler outcome: ${JSON.stringify(handled.outcome)}`);
}

describe("wake: what Inbox does with the wake gate's answer", () => {
  it.each([
    { wake: "wake", outcome: "woke" },
    { wake: "quiet", outcome: "quiet" },
    { wake: "block", outcome: "blocked" },
  ] as const)("the gate says $wake → $outcome", async ({ wake, outcome }) => {
    const handled = await handle({ wake });
    expect(wakeOf(handled)).toBe(outcome);
  });

  it("records a message that wakes the agent as said to it, and any other as said around it", async () => {
    const woke = await handle({ wake: "wake" });
    const quiet = await handle({ wake: "quiet" });
    const blocked = await handle({ wake: "block" });

    expect(woke.stored.map((m) => m.role)).toEqual(["user"]);
    expect(quiet.stored.map((m) => m.role)).toEqual(["notification"]);
    expect(blocked.stored).toEqual([]);
  });

  it("on a message the host recorded, makes it the turn's prompt only when it wakes the agent", async () => {
    const woke = await handle({ wake: "wake", recorded: true });
    const quiet = await handle({ wake: "quiet", recorded: true });
    const blocked = await handle({ wake: "block", recorded: true });

    for (const handled of [woke, quiet, blocked]) {
      expect(handled.stored).toEqual([]);
    }
    expect(woke.promoted).toEqual(["message-1"]);
    expect(quiet.promoted).toEqual([]);
    expect(blocked.promoted).toEqual([]);
  });

  it("asks the gate about the chat, whoever sent the message", async () => {
    const handled = await handle({});

    expect(handled.wakeRequests).toEqual([
      [
        {
          connectionId: "connection:telegram",
          chatId: "chat-1",
          channel: "telegram",
          place: "group",
          threadName: "Dev Chat",
        },
      ],
    ]);
  });

  it("takes the hook's decision without asking the gate again", async () => {
    const woke = await handle({ wake: "block", decidedByHook: "wake" });

    expect(wakeOf(woke)).toBe("woke");
    expect(woke.wakeRequests).toEqual([]);
  });
});

describe("send: the agent's reply", () => {
  it("goes out as it is, with no other agent", async () => {
    const handled = await handle({ answers: [[result("Hi")]] });

    expect(handled.outcome.data).toEqual({ action: "sent", response: "Hi" });
    expect(handled.runs.map((run) => run.agentName)).toEqual(["main"]);
    expect(handled.sent).toEqual([expect.objectContaining({ text: "Hi", threadId: "chat-1" })]);
  });

  it("sends nothing when the agent says nothing", async () => {
    const handled = await handle({});

    expect(handled.outcome.data).toMatchObject({ action: "no_response" });
    expect(handled.runs.map((run) => run.agentName)).toEqual(["main"]);
    expect(handled.sent).toEqual([]);
  });
});

describe("wake: in the hook", () => {
  async function hear(options: {
    enabled: boolean;
    accountAgent: string | null | undefined;
    recorded: boolean;
    /** The wake gate's answer for a recorded message. Unset, it wakes
     *  whatever an enabled chat hears, as core's gate does. */
    gate?: ReturnType<WakeGate>;
  }) {
    const run = rs.fn(async () => ({ status: "ok" as const }));
    const typing = rs.fn(async () => null);
    const download = rs.fn(async () => []);
    let handler: ((event: InboundEvent) => Promise<void>) | undefined;
    let recordedHandler: ((event: SaidInboundEvent) => Promise<void>) | undefined;
    const messagesSaid: MessagesSaid = {
      subscribe: (h) => {
        recordedHandler = h;
        return () => {};
      },
      decided: async () => {},
    };
    const channel: Channel = {
      name: "telegram",
      send: { send: async () => ({}), activity: { begin: typing } },
      inbound: {
        subscribe: (h) => {
          handler = h;
          return () => {};
        },
        media: { materialize: download },
      },
    } as unknown as Channel;
    const chatSettings = {
      get: async () => ({
        effective: { enabled: options.enabled, routing: { agentName: null } },
        overrides: {},
      }),
    } as unknown as ChatSettingsControl;
    const hook = new ChannelMessageHook(
      { run } as unknown as ActionEngineLike,
      chatSettings,
      async () => ({ status: "stop_requested" as const, turnId: "turn-1" }),
      [channel],
      {
        accountAgentOf: () => options.accountAgent,
        ...(options.recorded ? { messagesSaid } : {}),
        wakeGateFor: async () => () => options.gate ?? (options.enabled ? "wake" : "quiet"),
      },
    );
    await hook.register();
    const event: InboundEvent = {
      kind: "message",
      ref: { connectionId: "connection:telegram", chatId: "chat-1" as ChatId },
      message: {
        channel: "telegram",
        direction: "inbound",
        messageId: "message-1",
        chatId: "chat-1" as ChatId,
        senderId: "user-1",
        senderDisplayName: "Alice",
        text: "Can you help?",
        attachments: [{ type: "image", url: "file-1" }],
        timestamp: new Date("2026-01-20T12:00:00Z"),
        thread: { kind: "group", name: "Dev Chat" },
      },
    };
    if (options.recorded) {
      await recordedHandler?.({
        ...event,
        recorded: { chatRecordId: "chat-1", messageId: "recorded-1" },
      });
    } else {
      await handler?.(event);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const args = run.mock.calls[0]?.[1] as { wake?: string } | undefined;
    return {
      heard: run.mock.calls.length > 0 ? "handled" : "quiet",
      wake: args?.wake,
      typing: typing.mock.calls.length > 0,
    };
  }

  it.each(
    [
      { enabled: true, agent: "main", accountAgent: "main", heard: "handled" },
      // A host that predates accounts names no agent, and answers the connection.
      { enabled: true, agent: "not named", accountAgent: undefined, heard: "handled" },
      { enabled: false, agent: "main", accountAgent: "main", heard: "quiet" },
      // An account whose agent was unlinked answers nothing.
      { enabled: true, agent: "unlinked", accountAgent: null, heard: "quiet" },
    ].flatMap((row) => [
      { ...row, recorded: true },
      { ...row, recorded: false },
    ]),
  )("recorded $recorded, chat enabled $enabled, account's agent $agent → $heard", async ({
    heard,
    agent: _label,
    ...options
  }) => {
    const result = await hear(options);
    expect(result.heard).toBe(heard);
  });

  // The hook asks the gate for a recorded message, so a message that wakes
  // nobody shows no typing.
  it.each([
    { gate: "wake", heard: "handled", wake: "wake", typing: true },
    { gate: "quiet", heard: "quiet", wake: undefined, typing: false },
    { gate: "block", heard: "quiet", wake: undefined, typing: false },
  ] as const)("for a recorded message, the gate says $gate → $heard", async ({
    gate,
    heard,
    wake,
    typing,
  }) => {
    const result = await hear({ enabled: true, accountAgent: "main", recorded: true, gate });
    expect(result).toMatchObject({ heard, wake, typing });
  });
});
