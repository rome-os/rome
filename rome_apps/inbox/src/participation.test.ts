/**
 * Pins how Inbox decides today whether a message wakes an agent, and whether
 * the agent's reply goes out. The wake gate and send gate moving into Core
 * keep every row here green, and the table becomes their providers' shared
 * suite. One row is one case: change a row only when the behavior is meant
 * to change.
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
  PersonRecord,
  PolicyRule,
  RunParams,
} from "@rome-os/app-runtime";
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
  /** What the policy engine answers for the message. */
  policy: PolicyRule["action"];
  /** The `trustedBondLevels` setting, or the default (`guardian`) when absent. */
  trusted?: string[];
  /** The `replyToBondLevels` setting, or the default (`guardian`) when absent. */
  replyTo?: string[];
  /** What each agent answers, in the order they run. */
  answers?: AgentMessage[][];
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
  const settings: Record<string, unknown> = {
    ...(setup.trusted ? { trustedBondLevels: setup.trusted } : {}),
    ...(setup.replyTo ? { replyToBondLevels: setup.replyTo } : {}),
  };
  const stored: { role: string }[] = [];
  const promoted: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const approvals: Record<string, unknown>[] = [];
  const policyContexts: unknown[] = [];

  const action = createAction(actionConfig, {
    agentRunner,
    personMappingRepo: {
      findByChannelUser: async () => (setup.sender === "stranger" ? null : person(setup.sender)),
    },
    sentinelLogRepo: { create: async () => "sentinel-1" },
    approvalsRepo: {
      create: async (approval: Record<string, unknown>) => {
        approvals.push(approval);
        return "approval-1";
      },
    },
    policyEngine: {
      evaluate: async (context: unknown) => {
        policyContexts.push(context);
        return { action: setup.policy };
      },
    },
    appContext: {
      repositories: {
        settings: { get: async (key: string) => settings[key] ?? null },
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
    threadType: "group",
    displayName: "Alice",
    text: "Can you help?",
    messageId: "message-1",
  });

  return { outcome, runs, stored, promoted, sent, approvals, policyContexts };
}

type Wake = "woke" | "quiet" | "blocked" | "reviewed";

/** The wake decision as a caller sees it: which agent ran first, if any. */
function wakeOf(handled: Awaited<ReturnType<typeof handle>>): Wake {
  const data = handled.outcome.data as { action?: string } | undefined;
  if (data?.action === "blocked") return "blocked";
  if (data?.action === "ignored_by_reply_settings") return "quiet";
  const first = handled.runs[0]?.agentName;
  if (first === "sentinel") return "reviewed";
  if (first === "main") return "woke";
  throw new Error(`unexpected handler outcome: ${JSON.stringify(handled.outcome)}`);
}

describe("wake: sender × policy × settings", () => {
  const rows: (Setup & { wake: Wake })[] = [
    // The guardian is trusted by default, so only a block keeps the agent asleep.
    { sender: "guardian", policy: "allow", wake: "woke" },
    { sender: "guardian", policy: "sentinel_review", wake: "woke" },
    { sender: "guardian", policy: "require_approval", wake: "woke" },
    { sender: "guardian", policy: "block", wake: "blocked" },

    // By default the agent replies to the guardian alone, so anyone else stays quiet.
    { sender: "stranger", policy: "sentinel_review", wake: "quiet" },
    { sender: "stranger", policy: "allow", wake: "quiet" },
    { sender: "inner-circle", policy: "allow", wake: "quiet" },
    { sender: "acquaintance", policy: "sentinel_review", wake: "quiet" },

    // A block wins over every setting.
    { sender: "stranger", policy: "block", wake: "blocked" },
    {
      sender: "inner-circle",
      policy: "block",
      trusted: ["guardian", "inner-circle"],
      replyTo: ["guardian", "inner-circle"],
      wake: "blocked",
    },

    // A sender the agent may reply to: trusted wakes, untrusted goes to review
    // unless the policy allows it.
    {
      sender: "inner-circle",
      policy: "sentinel_review",
      replyTo: ["guardian", "inner-circle"],
      wake: "reviewed",
    },
    {
      sender: "inner-circle",
      policy: "require_approval",
      replyTo: ["guardian", "inner-circle"],
      wake: "reviewed",
    },
    {
      sender: "inner-circle",
      policy: "allow",
      replyTo: ["guardian", "inner-circle"],
      wake: "woke",
    },
    {
      sender: "inner-circle",
      policy: "sentinel_review",
      trusted: ["guardian", "inner-circle"],
      replyTo: ["guardian", "inner-circle"],
      wake: "woke",
    },
    { sender: "stranger", policy: "sentinel_review", replyTo: ["other"], wake: "reviewed" },
    { sender: "other", policy: "allow", replyTo: ["other"], wake: "woke" },

    // The reply rule wins over trust: a trusted sender the agent may not reply to stays quiet.
    {
      sender: "inner-circle",
      policy: "allow",
      trusted: ["guardian", "inner-circle"],
      wake: "quiet",
    },
    // A guardian left out of the reply rule stays quiet too.
    { sender: "guardian", policy: "allow", replyTo: ["inner-circle"], wake: "quiet" },
  ];

  it.each(rows)("$sender, policy $policy, trusted $trusted, reply to $replyTo → $wake", async ({
    wake,
    ...setup
  }) => {
    const answers = wake === "reviewed" ? [[result("IGNORE")]] : [];
    const handled = await handle({ ...setup, answers });
    expect(wakeOf(handled)).toBe(wake);
  });

  it("records a message that wakes the agent as said to it, and any other as said around it", async () => {
    const woke = await handle({ sender: "guardian", policy: "allow" });
    const quiet = await handle({ sender: "stranger", policy: "allow" });
    const reviewed = await handle({
      sender: "stranger",
      policy: "sentinel_review",
      replyTo: ["other"],
      answers: [[result("IGNORE")]],
    });
    const blocked = await handle({ sender: "guardian", policy: "block" });

    expect(woke.stored.map((m) => m.role)).toEqual(["user"]);
    expect(quiet.stored.map((m) => m.role)).toEqual(["notification"]);
    expect(reviewed.stored.map((m) => m.role)).toEqual(["notification"]);
    expect(blocked.stored).toEqual([]);
  });

  it("asks the policy engine about the linked person, or no one for a stranger", async () => {
    const linked = await handle({ sender: "inner-circle", policy: "allow" });
    const stranger = await handle({ sender: "stranger", policy: "allow" });

    expect(linked.policyContexts).toEqual([
      expect.objectContaining({
        channel: "telegram",
        sender: { id: "person-inner-circle", bondLevel: "inner-circle" },
        bondLevel: "inner-circle",
        threadName: "Dev Chat",
        threadType: "group",
      }),
    ]);
    expect(stranger.policyContexts).toEqual([
      expect.objectContaining({ sender: null, bondLevel: "other" }),
    ]);
  });
});

describe("wake: what review decides", () => {
  const reviewable: Setup = { sender: "stranger", policy: "sentinel_review", replyTo: ["other"] };

  it.each([
    { sentinel: "IGNORE", action: "sentinel_ignored", agents: ["sentinel"] },
    { sentinel: "REPLY: Hi there", action: "sentinel_replied", agents: ["sentinel"] },
    { sentinel: "ESCALATE", action: "no_response", agents: ["sentinel", "main"] },
    { sentinel: "", action: "no_response", agents: ["sentinel", "main"] },
  ])("Sentinel answers '$sentinel' → $action", async ({ sentinel, action, agents }) => {
    const handled = await handle({ ...reviewable, answers: [[result(sentinel)]] });

    expect(handled.outcome.data).toMatchObject({ action });
    expect(handled.runs.map((run) => run.agentName)).toEqual(agents);
    // An escalated message wakes the agent as if it had been said to it.
    expect(handled.promoted).toEqual(agents.includes("main") ? ["message-1"] : []);
  });

  it("wakes the agent when Sentinel fails", async () => {
    const handled = await handle({
      ...reviewable,
      answers: [[{ type: "error", error: "model down" } as AgentMessage]],
    });

    expect(handled.runs.map((run) => run.agentName)).toEqual(["sentinel", "main"]);
    expect(handled.promoted).toEqual(["message-1"]);
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
  if (data.action === "rejected_by_envoy") return "refused";
  throw new Error(`unexpected handler outcome: ${JSON.stringify(handled.outcome)}`);
}

describe("send: recipient × Envoy", () => {
  const trustedInnerCircle = {
    trusted: ["guardian", "inner-circle"],
    replyTo: ["guardian", "inner-circle"],
  };

  const rows: {
    name: string;
    setup: Setup;
    send: Send;
    approval: { status?: string; description: string };
  }[] = [
    {
      name: "the guardian, without asking Envoy",
      setup: { sender: "guardian", policy: "allow", answers: [[result("Hi")]] },
      send: "sent",
      approval: { status: "auto_approved", description: "Skipped envoy (guardian)" },
    },
    {
      name: "anyone else, when Envoy approves",
      setup: {
        sender: "inner-circle",
        policy: "allow",
        ...trustedInnerCircle,
        answers: [[result("Hi")], [envoy("approve", "Friendly")]],
      },
      send: "checked",
      approval: { status: "auto_approved", description: "Friendly" },
    },
    {
      name: "anyone else, when Envoy asks the guardian",
      setup: {
        sender: "inner-circle",
        policy: "allow",
        ...trustedInnerCircle,
        answers: [[result("Hi")], [envoy("require_approval", "Mentions plans")]],
      },
      send: "held",
      approval: { description: "Mentions plans" },
    },
    {
      name: "anyone else, when Envoy rejects",
      setup: {
        sender: "inner-circle",
        policy: "allow",
        ...trustedInnerCircle,
        answers: [[result("Hi")], [envoy("reject", "Leaks an address")]],
      },
      send: "refused",
      approval: { status: "rejected", description: "Leaks an address" },
    },
    {
      name: "anyone else, when Envoy answers without a verdict",
      setup: {
        sender: "inner-circle",
        policy: "allow",
        ...trustedInnerCircle,
        answers: [[result("Hi")], [result("looks fine")]],
      },
      send: "held",
      approval: { description: "Envoy answered without a verdict: looks fine" },
    },
    {
      name: "anyone else, when Envoy fails",
      setup: {
        sender: "inner-circle",
        policy: "allow",
        ...trustedInnerCircle,
        answers: [[result("Hi")], [{ type: "error", error: "model down" } as AgentMessage]],
      },
      send: "held",
      approval: { description: "Envoy validation failed: model down" },
    },
    {
      name: "a stranger the agent woke for after review, when Envoy approves",
      setup: {
        sender: "stranger",
        policy: "sentinel_review",
        replyTo: ["other"],
        answers: [[result("ESCALATE")], [result("Hi")], [envoy("approve", "Fine")]],
      },
      send: "checked",
      approval: { status: "auto_approved", description: "Fine" },
    },
  ];

  it.each(rows)("a reply to $name → $send", async ({ setup, send, approval }) => {
    const handled = await handle(setup);

    expect(sendOf(handled)).toBe(send);
    expect(handled.sent.length).toBe(send === "sent" || send === "checked" ? 1 : 0);
    expect(handled.approvals).toHaveLength(1);
    expect(handled.approvals[0]).toEqual(
      expect.objectContaining({ type: "outgoing_message", requestedBy: "main", ...approval }),
    );
    if (!approval.status) expect(handled.approvals[0]).not.toHaveProperty("status");
  });

  it("sends Sentinel's own reply without asking Envoy", async () => {
    const handled = await handle({
      sender: "stranger",
      policy: "sentinel_review",
      replyTo: ["other"],
      answers: [[result("REPLY: I'll pass that on")]],
    });

    expect(handled.runs.map((run) => run.agentName)).toEqual(["sentinel"]);
    expect(handled.sent).toEqual([expect.objectContaining({ text: "I'll pass that on" })]);
    expect(handled.approvals).toEqual([]);
  });

  it("sends nothing and asks no one when the agent says nothing", async () => {
    const handled = await handle({
      sender: "inner-circle",
      policy: "allow",
      ...trustedInnerCircle,
    });

    expect(handled.outcome.data).toMatchObject({ action: "no_response" });
    expect(handled.runs.map((run) => run.agentName)).toEqual(["main"]);
    expect(handled.sent).toEqual([]);
    expect(handled.approvals).toEqual([]);
  });
});

describe("wake: chat on/off and the account's agent", () => {
  async function hear(options: { enabled: boolean; accountAgent: string | null | undefined }) {
    const run = rs.fn(async () => ({ status: "ok" as const }));
    let handler: ((event: InboundEvent) => Promise<void>) | undefined;
    const channel: Channel = {
      name: "telegram",
      inbound: {
        subscribe: (h) => {
          handler = h;
          return () => {};
        },
        media: null,
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
      { accountAgentOf: () => options.accountAgent },
    );
    await hook.register();
    await handler?.({
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
        attachments: [],
        timestamp: new Date("2026-01-20T12:00:00Z"),
        thread: { kind: "group", name: "Dev Chat" },
      },
    });
    return run.mock.calls.length > 0 ? "handled" : "quiet";
  }

  it.each([
    { enabled: true, agent: "main", accountAgent: "main", heard: "handled" },
    // A host that predates accounts names no agent, and answers the connection.
    { enabled: true, agent: "not named", accountAgent: undefined, heard: "handled" },
    { enabled: false, agent: "main", accountAgent: "main", heard: "quiet" },
    // An account whose agent was unlinked answers nothing.
    { enabled: true, agent: "unlinked", accountAgent: null, heard: "quiet" },
  ])("chat enabled $enabled, account's agent $agent → $heard", async ({
    heard,
    agent: _label,
    ...options
  }) => {
    expect(await hear(options)).toBe(heard);
  });
});
