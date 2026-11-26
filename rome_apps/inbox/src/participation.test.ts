/**
 * Pins how Inbox decides today whether a message wakes an agent, and whether
 * the agent's reply goes out. The wake gate and send gate moving into Core
 * keep every row here green, and the table becomes their providers' shared
 * suite. One row is one case: change a row only when the behavior is meant
 * to change.
 *
 * The gates' own tables live with them in packages/core/src/participation:
 * which policy and settings wake the agent (chat-settings-wake.test.ts),
 * and which reply is checked (guarded-send.test.ts). The rows here take the
 * gates' answers as given and pin what Inbox does with each.
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
  PersonRecord,
  RunParams,
  SaidInboundEvent,
} from "@rome-os/app-runtime";
import type { SendGate, WakeGate } from "./actions/message-handler/index.js";
import { createAction } from "./actions/message-handler/index.js";
import { ChannelMessageHook } from "./hooks/channel-message/index.js";

const STRANGER_PERSON_ID = "__STRANGER__";

const actionConfig: ActionConfig = {
  name: "inbox:message_handler",
  type: "system",
  description: "Handle incoming messages",
  complexity: "moderate",
  speed: "moderate",
  reliability: "high",
  sideEffects: "write",
};

type BondLevel = "guardian" | "inner-circle" | "acquaintance" | "other";

interface Setup {
  /** The sender's bond level, or `stranger` for an account linked to no person. */
  sender: BondLevel | "stranger";
  /** What Core's wake gate answers, `wake` when absent. */
  wake?: ReturnType<WakeGate>;
  /** The hook's decision passed on with the message, so Inbox asks no gate. */
  decidedByHook?: "wake";
  /** What each agent answers, in the order they run. */
  answers?: AgentMessage[][];
  /** What Core's send gate answers. Its own table is guarded-send.test.ts in
   *  packages/core/src/participation/send-gate. */
  gate?: ReturnType<SendGate>;
  /** The host recorded the message before Inbox heard it, as it does when it
   *  hands the hook `messagesSaid`. */
  recorded?: boolean;
  /** Where the message was said: a direct message, or a group (the default). */
  threadType?: "private" | "group";
}

function result(content: string, structuredOutput?: unknown): AgentMessage {
  return { type: "result", content, ...(structuredOutput ? { structuredOutput } : {}) };
}

function envoy(verdict: string, reason: string): AgentMessage {
  return result(JSON.stringify({ verdict, reason }), { verdict, reason });
}

function person(bondLevel: BondLevel): PersonRecord {
  return {
    id: `person-${bondLevel}`,
    displayName: `Person ${bondLevel}`,
    bondLevel,
    channelMappings: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
  } as PersonRecord;
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
  const approvals: Record<string, unknown>[] = [];
  const wakeRequests: Parameters<WakeGate>[] = [];
  const gateRequests: Parameters<SendGate>[0][] = [];

  const action = createAction(actionConfig, {
    agentRunner,
    sendGate: (request: Parameters<SendGate>[0]) => {
      gateRequests.push(request);
      return setup.gate ?? "check";
    },
    personMappingRepo: {
      findByChannelUser: async () => (setup.sender === "stranger" ? null : person(setup.sender)),
    },
    approvalsRepo: {
      create: async (approval: Record<string, unknown>) => {
        approvals.push(approval);
        return "approval-1";
      },
    },
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
    strangerPersonId: STRANGER_PERSON_ID,
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

  return { outcome, runs, stored, promoted, sent, approvals, wakeRequests, gateRequests };
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
    const handled = await handle({ sender: "inner-circle", wake });
    expect(wakeOf(handled)).toBe(outcome);
  });

  it("records a message that wakes the agent as said to it, and any other as said around it", async () => {
    const woke = await handle({ sender: "guardian", wake: "wake" });
    const quiet = await handle({ sender: "stranger", wake: "quiet" });
    const blocked = await handle({ sender: "guardian", wake: "block" });

    expect(woke.stored.map((m) => m.role)).toEqual(["user"]);
    expect(quiet.stored.map((m) => m.role)).toEqual(["notification"]);
    expect(blocked.stored).toEqual([]);
  });

  it("on a message the host recorded, makes it the turn's prompt only when it wakes the agent", async () => {
    const woke = await handle({ sender: "guardian", wake: "wake", recorded: true });
    const quiet = await handle({ sender: "stranger", wake: "quiet", recorded: true });
    const blocked = await handle({ sender: "guardian", wake: "block", recorded: true });

    for (const handled of [woke, quiet, blocked]) {
      expect(handled.stored).toEqual([]);
    }
    expect(woke.promoted).toEqual(["message-1"]);
    expect(quiet.promoted).toEqual([]);
    expect(blocked.promoted).toEqual([]);
  });

  it("asks the gate about the chat and the linked person, or no one for a stranger", async () => {
    const linked = await handle({ sender: "inner-circle" });
    const stranger = await handle({ sender: "stranger" });

    expect(linked.wakeRequests).toEqual([
      [
        {
          connectionId: "connection:telegram",
          chatId: "chat-1",
          channel: "telegram",
          place: "group",
          threadName: "Dev Chat",
        },
        { person: { id: "person-inner-circle", bondLevel: "inner-circle" } },
      ],
    ]);
    expect(stranger.wakeRequests).toEqual([[expect.anything(), { person: null }]]);
  });

  it("takes the hook's decision without asking the gate again", async () => {
    const woke = await handle({ sender: "guardian", wake: "block", decidedByHook: "wake" });

    expect(wakeOf(woke)).toBe("woke");
    expect(woke.wakeRequests).toEqual([]);
  });
});

type Send = "sent" | "checked" | "held" | "refused";

/** The send decision as a caller sees it: whether the reply went out, and
 *  whether Envoy looked at it first. */
function sendOf(handled: Awaited<ReturnType<typeof handle>>): Send {
  const envoyRan = handled.runs.some((run) => run.agentName === "envoy");
  const data = handled.outcome.data as { action?: string };
  if (data.action === "sent") return envoyRan ? "checked" : "sent";
  if (data.action === "pending_approval") return "held";
  if (data.action === "rejected_by_envoy" || data.action === "rejected_by_send_gate") {
    return "refused";
  }
  throw new Error(`unexpected handler outcome: ${JSON.stringify(handled.outcome)}`);
}

describe("send: send gate × Envoy", () => {
  const woken: Setup = { sender: "inner-circle", wake: "wake" };

  const rows: {
    name: string;
    gate: ReturnType<SendGate>;
    envoy?: AgentMessage;
    send: Send;
    approval: { status?: string; description: string };
  }[] = [
    {
      name: "the gate says send",
      gate: "send",
      send: "sent",
      approval: { status: "auto_approved", description: "Skipped envoy (guardian)" },
    },
    {
      name: "the gate asks the guardian",
      gate: "ask_guardian",
      send: "held",
      approval: { description: "Held by the send gate" },
    },
    {
      name: "the gate refuses",
      gate: "refuse",
      send: "refused",
      approval: { status: "rejected", description: "Refused by the send gate" },
    },
    {
      name: "the gate asks for a check and Envoy approves",
      gate: "check",
      envoy: envoy("approve", "Friendly"),
      send: "checked",
      approval: { status: "auto_approved", description: "Friendly" },
    },
    {
      name: "the gate asks for a check and Envoy asks the guardian",
      gate: "check",
      envoy: envoy("require_approval", "Mentions plans"),
      send: "held",
      approval: { description: "Mentions plans" },
    },
    {
      name: "the gate asks for a check and Envoy rejects",
      gate: "check",
      envoy: envoy("reject", "Leaks an address"),
      send: "refused",
      approval: { status: "rejected", description: "Leaks an address" },
    },
    {
      name: "the gate asks for a check and Envoy answers without a verdict",
      gate: "check",
      envoy: result("looks fine"),
      send: "held",
      approval: { description: "Envoy answered without a verdict: looks fine" },
    },
    {
      name: "the gate asks for a check and Envoy fails",
      gate: "check",
      envoy: { type: "error", error: "model down" } as AgentMessage,
      send: "held",
      approval: { description: "Envoy validation failed: model down" },
    },
  ];

  it.each(rows)("a reply when $name → $send", async ({ gate, envoy, send, approval }) => {
    const handled = await handle({
      ...woken,
      gate,
      answers: [[result("Hi")], ...(envoy ? [[envoy]] : [])],
    });

    expect(sendOf(handled)).toBe(send);
    expect(handled.runs.some((run) => run.agentName === "envoy")).toBe(gate === "check");
    expect(handled.sent.length).toBe(send === "sent" || send === "checked" ? 1 : 0);
    expect(handled.approvals).toHaveLength(1);
    expect(handled.approvals[0]).toEqual(
      expect.objectContaining({ type: "outgoing_message", requestedBy: "main", ...approval }),
    );
    if (!approval.status) expect(handled.approvals[0]).not.toHaveProperty("status");
  });

  it("asks the gate about the chat the message came from, the person who sent it, and the agent", async () => {
    const guardian = await handle({
      sender: "guardian",
      answers: [[result("Hi")]],
    });
    const stranger = await handle({
      sender: "stranger",
      answers: [[result("Hi")], [envoy("approve", "Fine")]],
    });

    const guardianDirect = await handle({
      sender: "guardian",
      threadType: "private",
      answers: [[result("Hi")]],
    });

    // The guardian's message answered in a group: others read the reply.
    expect(guardian.gateRequests).toEqual([
      {
        destination: {
          connectionId: "connection:telegram",
          chatId: "chat-1",
          place: "group",
          sameChatAsWake: true,
          onlyGuardianReads: false,
        },
        recipient: { bondLevel: "guardian" },
        author: { agentName: "main" },
      },
    ]);
    expect(guardianDirect.gateRequests).toEqual([
      expect.objectContaining({
        destination: expect.objectContaining({
          place: "direct",
          sameChatAsWake: true,
          onlyGuardianReads: true,
        }),
      }),
    ]);
    expect(stranger.gateRequests).toEqual([expect.objectContaining({ recipient: null })]);
  });

  it("sends nothing and asks no one when the agent says nothing", async () => {
    const handled = await handle(woken);

    expect(handled.outcome.data).toMatchObject({ action: "no_response" });
    expect(handled.runs.map((run) => run.agentName)).toEqual(["main"]);
    expect(handled.gateRequests).toEqual([]);
    expect(handled.sent).toEqual([]);
    expect(handled.approvals).toEqual([]);
  });
});

describe("wake: in the hook", () => {
  async function hear(options: {
    enabled: boolean;
    accountAgent: string | null | undefined;
    recorded: boolean;
    /** The wake gate's answer, for a recorded message that names its sender. */
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
        wakeGateFor: async () => () => options.gate ?? "wake",
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
        ...(options.gate ? { sender: { person: null, delegate: false, label: "not linked" } } : {}),
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
  )("with no sender named: recorded $recorded, chat enabled $enabled, account's agent $agent → $heard", async ({
    heard,
    agent: _label,
    ...options
  }) => {
    expect((await hear(options)).heard).toBe(heard);
  });

  // The hook asks the gate once People's answer comes with the message, so a
  // message that wakes nobody shows no typing. Before
  // the wake gate, the hook showed typing for it and Inbox dropped it after.
  it.each([
    { gate: "wake", heard: "handled", wake: "wake", typing: true },
    { gate: "quiet", heard: "quiet", wake: undefined, typing: false },
    { gate: "block", heard: "quiet", wake: undefined, typing: false },
  ] as const)("with the sender named, the gate says $gate → $heard", async ({
    gate,
    heard,
    wake,
    typing,
  }) => {
    const result = await hear({ enabled: true, accountAgent: "main", recorded: true, gate });
    expect(result).toEqual({ heard, wake, typing });
  });
});
