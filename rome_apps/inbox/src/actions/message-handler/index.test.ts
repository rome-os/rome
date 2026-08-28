import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ActionConfig,
  AgentMessage,
  AgentRunnerInterface,
  PersonRecord,
  RunParams,
} from "@rome-os/app-runtime";
import {
  appendAttachmentPathsToPrompt,
  buildMessageContext,
  createAction as createMessageHandlerAction,
  parseSentinelDecision,
} from "./index.js";

const STRANGER_PERSON_ID = "__STRANGER__";

const actionConfig: ActionConfig = {
  name: "message_handler",
  type: "system",
  description: "Handle incoming messages",
  complexity: "moderate",
  speed: "moderate",
  reliability: "high",
  sideEffects: "write",
};

function createTempProfile(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "message-handler-test-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }
  return dir;
}

function createMockAgentRunner(
  responses: AgentMessage[][] = [],
  options: { knownAgents?: string[]; actionCapableAgents?: Record<string, string[]> } = {},
): AgentRunnerInterface & { calls: RunParams[] } {
  let callIndex = 0;
  const calls: RunParams[] = [];
  // Catalog of agents the runner pretends to know. Defaults to the core trio
  // plus envoy so existing tests don't need to opt in.
  const known = new Set(options.knownAgents ?? ["main", "sentinel", "envoy"]);
  const actionCapable = options.actionCapableAgents ?? {};

  return {
    calls,
    async *run(params: RunParams): AsyncIterable<AgentMessage> {
      calls.push(params);
      for (const message of responses[callIndex++] ?? []) {
        yield message;
      }
    },
    hasAgent(name: string): boolean {
      return known.has(name);
    },
    hasAction(agentName: string, actionName: string): boolean {
      return (actionCapable[agentName] ?? []).includes(actionName);
    },
  };
}

function createAction(
  config: ActionConfig,
  deps: Parameters<typeof createMessageHandlerAction>[1],
) {
  const action = createMessageHandlerAction(config, deps);
  return {
    ...action,
    execute(args: Record<string, unknown>) {
      return action.execute({
        connectionId: `connection:${String(args.channel)}`,
        ...args,
      });
    },
  };
}

function createMessageHandlerDeps(
  overrides: {
    personMappingRepo?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    agentResponses?: AgentMessage[][];
    knownAgents?: string[];
    actionCapableAgents?: Record<string, string[]>;
    conversations?: Record<string, unknown>;
  } = {},
) {
  const agentRunner = createMockAgentRunner(overrides.agentResponses, {
    knownAgents: overrides.knownAgents,
    actionCapableAgents: overrides.actionCapableAgents,
  });
  const sentMessages: Record<string, unknown>[] = [];
  const approvals: Record<string, unknown>[] = [];
  const settings = overrides.settings ?? {};
  const conversations = {
    ensureChannelConversation: rs.fn(async (input: Record<string, unknown>) => ({
      id: `channel:${String(input.channel)}:${String(input.threadId)}`,
      agentName: input.agentName === "main" ? null : String(input.agentName),
    })),
    addMessage: rs.fn(async () => ({ inserted: true })),
    promoteMessageToUser: rs.fn(async () => undefined),
    recordOutboundMessage: rs.fn(async () => undefined),
    ...overrides.conversations,
  };

  const deps = {
    agentRunner,
    personMappingRepo: {
      findByChannelUser: rs.fn(async () => null),
      findByName: rs.fn(async () => []),
      findByNameFuzzy: rs.fn(async () => null),
      findByBondLevel: rs.fn(async () => []),
      create: rs.fn(async () => "person-1"),
      addChannelMapping: rs.fn(async () => undefined),
      ...overrides.personMappingRepo,
    },
    sentinelLogRepo: {
      create: rs.fn(async () => "sentinel-1"),
      findUnreviewed: rs.fn(async () => []),
      markReviewed: rs.fn(async () => undefined),
    },
    approvalsRepo: {
      create: rs.fn(async (approval: Record<string, unknown>) => {
        approvals.push(approval);
        return "approval-1";
      }),
    },
    policyEngine: {
      evaluate: rs.fn(async () => ({ action: "allow" as const })),
    },
    appContext: {
      app: { id: "inbox", version: "0.1.0", description: "Inbox" },
      controller: {},
      db: {} as never,
      log: {} as never,
      repositories: {
        settings: {
          get: rs.fn(async (key: string) => (key in settings ? settings[key] : null)),
          set: rs.fn(async () => undefined),
        },
        conversations,
      },
      runAction: rs.fn(async (_name: string, args: Record<string, unknown>) => {
        sentMessages.push(args);
        return { status: "ok" };
      }),
      listRoutines: rs.fn(async () => []),
    },
    resolveProfilePath: (filePath: string) => filePath,
    strangerPersonId: STRANGER_PERSON_ID,
  } as unknown as Parameters<typeof createAction>[1];

  return { deps, agentRunner, sentMessages, approvals, conversations };
}

describe("buildMessageContext", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  it("loads guardian and sender markdown for non-guardian messages", () => {
    const profileDir = createTempProfile({
      "memory/relationship/GUARDIAN.md": "# Guardian Profile\n\nName: Test Guardian",
      "memory/relationship/alice.md": "# Alice\n\nLikes concise updates.",
    });

    const result = buildMessageContext({
      channel: "telegram",
      threadId: "thread-123",
      channelUserId: "user-456",
      displayName: "Alice",
      bondLevel: "inner-circle",
      person: {
        id: "alice",
        displayName: "Alice",
        bondLevel: "inner-circle",
        profilePath: "memory/relationship/alice.md",
        channelMappings: [],
        approved: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      resolveProfilePath: (filePath: string) => join(profileDir, filePath),
      strangerPersonId: STRANGER_PERSON_ID,
    });

    expect(result).toContain("## Guardian");
    expect(result).toContain("Name: Test Guardian");
    expect(result).toContain("## Sender info");
    expect(result).toContain("# Alice");
    expect(result).toContain("Likes concise updates.");
    // Thread + project framing now lives in the `<thread_context>` block on the
    // session's first user message (see @rome/core buildThreadContextBlock), not
    // in this system-prompt suffix.
    expect(result).not.toContain("## Thread context");
    expect(result).not.toContain("thread id: thread-123");
  });

  it("no longer embeds thread name / type (moved to the <thread_context> block)", () => {
    const profileDir = createTempProfile({
      "memory/relationship/GUARDIAN.md": "# Guardian Profile\n\nName: Test Guardian",
    });

    const result = buildMessageContext({
      channel: "telegram",
      threadId: "thread-group-1",
      threadName: "Dev Chat",
      threadType: "group",
      channelUserId: "user-456",
      displayName: "Alice",
      bondLevel: "guardian",
      person: null,
      resolveProfilePath: (filePath: string) => join(profileDir, filePath),
      strangerPersonId: STRANGER_PERSON_ID,
    });

    expect(result).not.toContain("## Thread context");
    expect(result).not.toContain("thread name: Dev Chat");
    expect(result).not.toContain("is group chat: yes");
  });

  it("no longer embeds the Discord channel-control cue (moved to the trusted-path injector)", () => {
    const profileDir = createTempProfile({
      "memory/relationship/GUARDIAN.md": "# Guardian Profile\n\nName: Test Guardian",
    });

    const base = {
      threadId: "thread-discord-1",
      threadName: "pm-bot",
      threadType: "group" as const,
      channelUserId: "user-456",
      displayName: "Guardian",
      bondLevel: "guardian",
      person: null,
      resolveProfilePath: (filePath: string) => join(profileDir, filePath),
      strangerPersonId: STRANGER_PERSON_ID,
    };

    // The cue is now appended in handleTrustedMessage once the routed target
    // agent is known, so buildMessageContext itself stays channel-agnostic.
    const discord = buildMessageContext({ ...base, channel: "discord" });
    expect(discord).not.toContain("## Discord channel control");

    const telegram = buildMessageContext({ ...base, channel: "telegram" });
    expect(telegram).not.toContain("## Discord channel control");
  });

  it("marks unknown senders as stranger", () => {
    const profileDir = createTempProfile({
      "memory/relationship/GUARDIAN.md": "# Guardian Profile\n\nName: Test Guardian",
    });

    const result = buildMessageContext({
      channel: "whatsapp",
      threadId: "555@s.whatsapp.net",
      channelUserId: "555@s.whatsapp.net",
      displayName: "Unknown",
      bondLevel: "other",
      person: {
        id: STRANGER_PERSON_ID,
        displayName: "Unknown",
        bondLevel: "other",
        channelMappings: [],
        approved: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      resolveProfilePath: (filePath: string) => join(profileDir, filePath),
      strangerPersonId: STRANGER_PERSON_ID,
    });

    expect(result).toContain("## Sender info");
    expect(result).toContain("stranger (no person mapping yet)");
  });

  it("omits sender info for guardian messages", () => {
    const profileDir = createTempProfile({
      "memory/relationship/GUARDIAN.md": "# Guardian Profile\n\nName: Test Guardian",
    });

    const result = buildMessageContext({
      channel: "webchat",
      threadId: "session-1",
      channelUserId: "guardian",
      displayName: "Guardian",
      bondLevel: "guardian",
      person: null,
      resolveProfilePath: (filePath: string) => join(profileDir, filePath),
      strangerPersonId: STRANGER_PERSON_ID,
    });

    expect(result).toContain("## Guardian");
    expect(result).not.toContain("## Thread context");
    expect(result).not.toContain("## Sender info");
  });

  it("no longer embeds the selected project (moved to the <thread_context> block)", () => {
    const profileDir = createTempProfile({
      "memory/relationship/GUARDIAN.md": "# Guardian Profile\n\nName: Test Guardian",
    });

    const result = buildMessageContext({
      channel: "webchat",
      threadId: "session-1",
      channelUserId: "guardian",
      displayName: "Guardian",
      bondLevel: "guardian",
      selectedProjectName: "alpha",
      selectedProjectPath: "/home/rome/.rome/default/projects/alpha",
      person: null,
      resolveProfilePath: (filePath: string) => join(profileDir, filePath),
      strangerPersonId: STRANGER_PERSON_ID,
    });

    expect(result).not.toContain("project name: alpha");
    expect(result).not.toContain("## Project context");
    expect(result).not.toContain("Current selected project");
  });
});

describe("appendAttachmentPathsToPrompt", () => {
  it("adds saved attachment paths to text prompts", () => {
    const result = appendAttachmentPathsToPrompt("Please inspect this", [
      {
        type: "image",
        fileName: "photo.png",
        caption: "front door",
        localPath: "/tmp/rome/photo.png",
      },
    ]);

    expect(result).toContain("Please inspect this");
    expect(result).toContain("Attachment 1 (image photo.png) path: /tmp/rome/photo.png");
    expect(result).toContain("caption: front door");
  });

  it("turns attachment-only messages into readable file prompts", () => {
    const result = appendAttachmentPathsToPrompt("", [
      { type: "image", localPath: "/tmp/rome/image.jpg" },
    ]);

    expect(result).toBe("Attachment 1 (image) path: /tmp/rome/image.jpg");
  });
});

describe("parseSentinelDecision", () => {
  it("extracts only the explicit reply body", () => {
    expect(parseSentinelDecision("REPLY: Hello there.")).toEqual({
      action: "replied",
      response: "Hello there.",
    });
    expect(
      parseSentinelDecision(
        "Reasoning: benign.\nDecision: REPLY\nResponse: Thanks for reaching out.",
      ),
    ).toEqual({
      action: "replied",
      response: "Thanks for reaching out.",
    });
  });

  it("does not send reasoning-only output as a reply", () => {
    expect(
      parseSentinelDecision(
        "Reasoning: This is a benign, simple informational question from a stranger.",
      ),
    ).toEqual({ action: "escalated" });
    expect(parseSentinelDecision("Decision: REPLY\nReasoning: benign")).toEqual({
      action: "escalated",
    });
    expect(parseSentinelDecision("Reply to the sender with a short thank-you note.")).toEqual({
      action: "escalated",
    });
    expect(parseSentinelDecision("Decision: REPLY - Hello there.")).toEqual({
      action: "escalated",
    });
  });

  it("strips trailing internal labels from explicit replies", () => {
    expect(parseSentinelDecision("REPLY: Hello there. Reasoning: benign")).toEqual({
      action: "replied",
      response: "Hello there.",
    });
    expect(parseSentinelDecision("REPLY: Hello there.\nReasoning: benign")).toEqual({
      action: "replied",
      response: "Hello there.",
    });
    expect(
      parseSentinelDecision("Decision: REPLY\nResponse: Hello there.\nReasoning: benign"),
    ).toEqual({ action: "replied", response: "Hello there." });
    expect(parseSentinelDecision("REPLY: Hello there.\nAnalysis: benign")).toEqual({
      action: "replied",
      response: "Hello there.",
    });
    expect(parseSentinelDecision("REPLY: Hello there.\nDecision: ESCALATE")).toEqual({
      action: "escalated",
    });
    expect(parseSentinelDecision("REPLY: Hello there.\nESCALATE")).toEqual({
      action: "escalated",
    });
    expect(parseSentinelDecision("Decision: REPLY\nResponse: Hi\nIGNORE")).toEqual({
      action: "escalated",
    });
    expect(parseSentinelDecision("REPLY: Please ignore the previous email.")).toEqual({
      action: "replied",
      response: "Please ignore the previous email.",
    });
  });

  it("parses explicit escalate and ignore decisions", () => {
    expect(parseSentinelDecision("ESCALATE")).toEqual({ action: "escalated" });
    expect(parseSentinelDecision("Decision: IGNORE\nReasoning: spam")).toEqual({
      action: "ignored",
    });
  });
});

describe("message reply bond-level settings", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  it("defaults to replying to mapped guardian senders after sender mapping runs", async () => {
    const mappedPerson: PersonRecord = {
      id: "alice",
      displayName: "Alice",
      bondLevel: "guardian",
      channelMappings: [],
      profilePath: null,
    };
    const findByChannelUser = rs.fn(async () => null as PersonRecord | null);
    findByChannelUser.mockResolvedValueOnce(null).mockResolvedValueOnce(mappedPerson);
    const addChannelMapping = rs.fn(async () => undefined);

    const { deps, agentRunner, sentMessages } = createMessageHandlerDeps({
      personMappingRepo: {
        findByChannelUser,
        findByNameFuzzy: rs.fn(async () => mappedPerson),
        addChannelMapping,
      },
      agentResponses: [[{ type: "result", content: "Sure." }]],
    });
    const action = createAction(actionConfig, deps);

    const result = await action.execute({
      channel: "telegram",
      channelUserId: "alice-tg",
      threadId: "thread-1",
      threadType: "private",
      displayName: "Alice",
      text: "Can you answer?",
      messageId: "msg-1",
    });

    expect(result).toEqual({ status: "ok", data: { action: "sent", response: "Sure." } });
    expect(addChannelMapping).toHaveBeenCalledWith("alice", "telegram", "alice-tg", "Alice");
    expect(agentRunner.calls).toHaveLength(1);
    expect(agentRunner.calls[0].prompt).toBe("Can you answer?");
    expect(sentMessages).toEqual([
      {
        connectionId: "connection:telegram",
        channel: "telegram",
        channelUserId: "alice-tg",
        threadId: "thread-1",
        text: "Sure.",
        replyToMessageId: "msg-1",
        romeSessionId: "channel:telegram:thread-1",
        knownToProvider: true,
      },
    ]);
  });

  it("defaults to ignoring mapped non-guardian senders", async () => {
    const mappedPerson: PersonRecord = {
      id: "alice",
      displayName: "Alice",
      bondLevel: "inner-circle",
      channelMappings: [{ channel: "telegram", channelUserId: "alice-tg" }],
      profilePath: null,
    };

    const { deps, agentRunner, sentMessages, conversations } = createMessageHandlerDeps({
      personMappingRepo: {
        findByChannelUser: rs.fn(async () => mappedPerson),
      },
    });
    const action = createAction(actionConfig, deps);

    const result = await action.execute({
      channel: "telegram",
      channelUserId: "alice-tg",
      threadId: "thread-1",
      threadType: "private",
      displayName: "Alice",
      text: "Can you answer?",
      messageId: "msg-1",
    });

    expect(result).toEqual({
      status: "ok",
      data: { action: "ignored_by_reply_settings", bondLevel: "inner-circle" },
    });
    expect(agentRunner.calls).toHaveLength(0);
    expect(sentMessages).toEqual([]);
    expect(conversations.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "channel:telegram:thread-1",
        role: "notification",
        platformMessageId: "msg-1",
        senderId: "alice-tg",
      }),
    );
  });

  it("passes provider reply context to the trusted turn without persisting a synthetic message", async () => {
    const mappedPerson: PersonRecord = {
      id: "ray",
      displayName: "Ray",
      bondLevel: "guardian",
      channelMappings: [{ channel: "wechat", channelUserId: "ray-wechat" }],
      profilePath: null,
    };
    const { deps, agentRunner, conversations } = createMessageHandlerDeps({
      personMappingRepo: {
        findByChannelUser: rs.fn(async () => mappedPerson),
      },
      agentResponses: [[{ type: "result", content: "Sure." }]],
    });
    const action = createAction(actionConfig, deps);

    await action.execute({
      channel: "wechat",
      channelUserId: "ray-wechat",
      threadId: "ray-wechat",
      threadType: "private",
      displayName: "Ray",
      text: "What does the first word mean?",
      messageId: "current-msg",
      replyTo: {
        messageId: "wechat-server-42",
        content: "Jack Ma profile",
        senderName: "Rome",
      },
    });

    expect(conversations.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ replyToPlatformMessageId: "wechat-server-42" }),
    );
    expect(agentRunner.calls[0]).toMatchObject({
      replyTo: {
        messageId: "wechat-server-42",
        content: "Jack Ma profile",
        senderName: "Rome",
      },
    });
  });

  it("deduplicates an inbound webhook before starting another agent turn", async () => {
    const mappedPerson: PersonRecord = {
      id: "alice",
      displayName: "Alice",
      bondLevel: "guardian",
      channelMappings: [{ channel: "telegram", channelUserId: "alice-tg" }],
      profilePath: null,
    };
    const { deps, agentRunner, sentMessages } = createMessageHandlerDeps({
      personMappingRepo: {
        findByChannelUser: rs.fn(async () => mappedPerson),
      },
      conversations: {
        addMessage: rs.fn(async () => ({ inserted: false })),
      },
    });
    const action = createAction(actionConfig, deps);

    const result = await action.execute({
      channel: "telegram",
      channelUserId: "alice-tg",
      threadId: "thread-1",
      threadType: "private",
      displayName: "Alice",
      text: "Can you answer?",
      messageId: "msg-1",
    });

    expect(result).toEqual({
      status: "ok",
      data: { action: "duplicate", messageId: "msg-1" },
    });
    expect(agentRunner.calls).toEqual([]);
    expect(sentMessages).toEqual([]);
  });

  it("uses replyToBondLevels to allow other senders explicitly", async () => {
    const mappedPerson: PersonRecord = {
      id: "casey",
      displayName: "Casey",
      bondLevel: "other",
      channelMappings: [{ channel: "telegram", channelUserId: "casey-tg" }],
      profilePath: null,
    };

    const { deps, agentRunner, sentMessages } = createMessageHandlerDeps({
      settings: { replyToBondLevels: ["guardian", "inner-circle", "acquaintance", "other"] },
      personMappingRepo: {
        findByChannelUser: rs.fn(async () => mappedPerson),
      },
      agentResponses: [
        [{ type: "result", content: "Sure." }],
        [{ type: "result", content: "APPROVE" }],
      ],
    });
    const action = createAction(actionConfig, deps);

    const result = await action.execute({
      channel: "telegram",
      channelUserId: "casey-tg",
      threadId: "thread-1",
      threadType: "private",
      displayName: "Casey",
      text: "Can you answer?",
      messageId: "msg-1",
    });

    expect(result).toEqual({ status: "ok", data: { action: "sent", response: "Sure." } });
    expect(agentRunner.calls).toHaveLength(2);
    expect(sentMessages).toEqual([
      {
        connectionId: "connection:telegram",
        channel: "telegram",
        channelUserId: "casey-tg",
        threadId: "thread-1",
        text: "Sure.",
        replyToMessageId: "msg-1",
        romeSessionId: "channel:telegram:thread-1",
        knownToProvider: true,
      },
    ]);
  });

  it("escalates malformed sentinel output instead of sending reasoning to other senders", async () => {
    const mappedPerson: PersonRecord = {
      id: "casey",
      displayName: "Casey",
      bondLevel: "other",
      channelMappings: [{ channel: "email", channelUserId: "casey@example.com" }],
      profilePath: null,
    };

    const { deps, agentRunner, sentMessages } = createMessageHandlerDeps({
      settings: { replyToBondLevels: ["guardian", "inner-circle", "acquaintance", "other"] },
      personMappingRepo: {
        findByChannelUser: rs.fn(async () => mappedPerson),
      },
      agentResponses: [
        [
          {
            type: "result",
            content: "Reasoning: This is a benign, simple informational question from a stranger.",
          },
        ],
        [{ type: "result", content: "Here is the answer." }],
        [{ type: "result", content: "APPROVE" }],
      ],
    });
    (deps.policyEngine.evaluate as ReturnType<typeof rs.fn>).mockResolvedValue({
      action: "sentinel_review",
    });
    const action = createAction(actionConfig, deps);

    const result = await action.execute({
      channel: "email",
      channelUserId: "casey@example.com",
      threadId: "mail-thread-1",
      threadType: "private",
      displayName: "Casey",
      text: "What is Rome?",
      messageId: "msg-1",
    });

    expect(result).toEqual({
      status: "ok",
      data: { action: "sent", response: "Here is the answer." },
    });
    expect(agentRunner.calls.map((call) => call.agentName)).toEqual(["sentinel", "main", "envoy"]);
    expect(sentMessages).toEqual([
      {
        connectionId: "connection:email",
        channel: "email",
        channelUserId: "casey@example.com",
        threadId: "mail-thread-1",
        text: "Here is the answer.",
        replyToMessageId: "msg-1",
        romeSessionId: "channel:email:mail-thread-1",
        knownToProvider: true,
      },
    ]);
  });

  it("still ignores other bond-level senders by default", async () => {
    const mappedPerson: PersonRecord = {
      id: "casey",
      displayName: "Casey",
      bondLevel: "other",
      channelMappings: [{ channel: "telegram", channelUserId: "casey-tg" }],
      profilePath: null,
    };

    const { deps, agentRunner, sentMessages } = createMessageHandlerDeps({
      personMappingRepo: {
        findByChannelUser: rs.fn(async () => mappedPerson),
      },
    });
    const action = createAction(actionConfig, deps);

    const result = await action.execute({
      channel: "telegram",
      channelUserId: "casey-tg",
      threadId: "thread-1",
      threadType: "private",
      displayName: "Casey",
      text: "Can you answer?",
      messageId: "msg-1",
    });

    expect(result).toEqual({
      status: "ok",
      data: { action: "ignored_by_reply_settings", bondLevel: "other" },
    });
    expect(agentRunner.calls).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-channel agent routing (e.g. Discord channel bound to an app-declared
// agent). The channel adapter resolves the override and the inbox hook passes
// it in as `routedAgentName`. Trusted-path messages should target that agent
// instead of "main"; untrusted messages still go through sentinel.
// ---------------------------------------------------------------------------

describe("per-channel agent routing (trusted path)", () => {
  beforeEach(() => {
    rs.clearAllMocks();
  });

  const guardianPerson: PersonRecord = {
    id: "guardian",
    displayName: "Guardian",
    bondLevel: "guardian",
    channelMappings: [{ channel: "discord", channelUserId: "g-discord" }],
    profilePath: null,
  };

  it("routes to the app-declared agent when channel binds one and it is in the catalog", async () => {
    const { deps, agentRunner, sentMessages, approvals } = createMessageHandlerDeps({
      personMappingRepo: { findByChannelUser: rs.fn(async () => guardianPerson) },
      knownAgents: ["main", "sentinel", "envoy", "pm-assistant"],
      // Guardian path skips envoy → only one agent run is performed.
      agentResponses: [[{ type: "result", content: "On it." }]],
    });
    const action = createAction(actionConfig, deps);

    const result = await action.execute({
      channel: "discord",
      channelUserId: "g-discord",
      threadId: "channel-pm",
      threadType: "group",
      displayName: "Guardian",
      text: "plan the sprint",
      messageId: "msg-1",
      routedAgentName: "pm-assistant",
    });

    expect(result).toEqual({ status: "ok", data: { action: "sent", response: "On it." } });
    expect(agentRunner.calls).toHaveLength(1);
    expect(agentRunner.calls[0].agentName).toBe("pm-assistant");
    expect(sentMessages).toHaveLength(1);
    // requestedBy reflects the actual routed agent so approvals UI can scope by source.
    expect(approvals[0]).toMatchObject({ requestedBy: "pm-assistant" });
  });

  it("uses the parent-derived routing for a native thread session", async () => {
    const { deps, conversations } = createMessageHandlerDeps({
      personMappingRepo: { findByChannelUser: rs.fn(async () => guardianPerson) },
      knownAgents: ["main", "sentinel", "envoy", "parent-agent"],
      agentResponses: [[{ type: "result", content: "Child reply" }]],
    });
    const action = createAction(actionConfig, deps);

    await action.execute({
      channel: "discord",
      channelUserId: "g-discord",
      threadId: "child-thread",
      parentThreadId: "parent-channel",
      threadType: "group",
      displayName: "Guardian",
      text: "hello from the child",
      messageId: "msg-child",
      routedAgentName: "parent-agent",
    });

    expect(conversations.ensureChannelConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        threadId: "child-thread",
        parentThreadId: "parent-channel",
        agentName: "parent-agent",
      }),
    );
  });

  it("falls back to main when the routed agent is not in the catalog (e.g. app uninstalled)", async () => {
    const { deps, agentRunner, approvals } = createMessageHandlerDeps({
      personMappingRepo: { findByChannelUser: rs.fn(async () => guardianPerson) },
      knownAgents: ["main", "sentinel", "envoy"], // pm-assistant intentionally absent
      agentResponses: [[{ type: "result", content: "Hi from main." }]],
    });
    const action = createAction(actionConfig, deps);

    await action.execute({
      channel: "discord",
      channelUserId: "g-discord",
      threadId: "channel-pm",
      threadType: "group",
      displayName: "Guardian",
      text: "hello",
      messageId: "msg-1",
      routedAgentName: "pm-assistant",
    });

    expect(agentRunner.calls[0].agentName).toBe("main");
    expect(approvals[0]).toMatchObject({ requestedBy: "main" });
  });

  it("honors the routed agent when the catalog check itself fails (transient RPC error)", async () => {
    // The worker-side hasAgent throws on transport failure (fail-closed for
    // validators); routing must not drop or re-route the message over that —
    // it honors the requested agent unchanged.
    const { deps, agentRunner } = createMessageHandlerDeps({
      personMappingRepo: { findByChannelUser: rs.fn(async () => guardianPerson) },
      agentResponses: [[{ type: "result", content: "Hi from pm-assistant." }]],
    });
    agentRunner.hasAgent = () => {
      throw new Error("RPC bridge down");
    };
    const action = createAction(actionConfig, deps);

    await action.execute({
      channel: "discord",
      channelUserId: "g-discord",
      threadId: "channel-pm",
      threadType: "group",
      displayName: "Guardian",
      text: "hello",
      messageId: "msg-1",
      routedAgentName: "pm-assistant",
    });

    expect(agentRunner.calls[0].agentName).toBe("pm-assistant");
  });

  it("defaults to main when routedAgentName is absent", async () => {
    const { deps, agentRunner } = createMessageHandlerDeps({
      personMappingRepo: { findByChannelUser: rs.fn(async () => guardianPerson) },
      agentResponses: [[{ type: "result", content: "Hi." }]],
    });
    const action = createAction(actionConfig, deps);

    await action.execute({
      channel: "discord",
      channelUserId: "g-discord",
      threadId: "channel-x",
      threadType: "group",
      displayName: "Guardian",
      text: "hello",
      messageId: "msg-1",
    });

    expect(agentRunner.calls[0].agentName).toBe("main");
  });

  it("does not affect the untrusted path — sentinel still triages", async () => {
    const strangerPerson: PersonRecord = {
      id: "stranger",
      displayName: "Stranger",
      bondLevel: "other",
      channelMappings: [{ channel: "discord", channelUserId: "s-discord" }],
      profilePath: null,
    };

    const { deps, agentRunner } = createMessageHandlerDeps({
      personMappingRepo: { findByChannelUser: rs.fn(async () => strangerPerson) },
      knownAgents: ["main", "sentinel", "envoy", "pm-assistant"],
      // Allow replies to "other" so the untrusted branch actually runs (the
      // default replyToBondLevels would otherwise short-circuit and ignore).
      settings: { replyToBondLevels: ["guardian", "inner-circle", "acquaintance", "other"] },
      agentResponses: [[{ type: "result", content: "IGNORE" }]],
    });
    // Force untrusted: bond level "other" isn't in the default trustedBondLevels
    // and policy.action !== "allow" → falls into handleUntrustedMessage.
    (deps.policyEngine.evaluate as ReturnType<typeof rs.fn>).mockResolvedValue({
      action: "monitor",
    });

    const action = createAction(actionConfig, deps);

    await action.execute({
      channel: "discord",
      channelUserId: "s-discord",
      threadId: "channel-pm",
      threadType: "group",
      displayName: "Stranger",
      text: "hi",
      messageId: "msg-1",
      routedAgentName: "pm-assistant", // should be ignored — untrusted path
    });

    // First (and only) run should target sentinel, NOT pm-assistant.
    expect(agentRunner.calls[0].agentName).toBe("sentinel");
  });
});
