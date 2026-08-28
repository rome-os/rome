// The Discord descriptor. Two layers under test:
//   1. isDiscordAuthError / descriptor shape / token-validate wiring — pure.
//   2. fault mapping — a fake DiscordAdapter (rs.mock of ../../channels/discord.js)
//      captures the descriptor's `onGatewayFault` wiring and lets us drive a
//      login rejection (DiscordjsError) and live gateway faults, asserting they
//      surface as CredentialRejected{ grant: "bot" } vs. Disconnected.
//
// The real DiscordAdapter constructs a live discord.js Client (gateway I/O), so
// unlike telegram's transformer seam we mock the adapter module wholesale — the
// descriptor's own mapping arithmetic is what this file pins, and the adapter's
// transport internals are covered by discord.test.ts.

import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { DiscordjsError, DiscordjsErrorCodes } from "discord.js";
import type { ConversationId, InboundMessage, NormalizedMessage } from "@rome-os/app-runtime";
import type { ChannelApiRequest, ChannelApiResult } from "../../channels/api-request.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import type { StreamFault, Talker } from "../types.js";

// ── Fake DiscordAdapter (module mock) ──────────────────────────────────────
// Captures the config the descriptor passes (so we can drive onGatewayFault)
// and lets a test make start() reject with a chosen error.
type FakeConfig = {
  botToken: string;
  onGatewayFault?: (f: { kind: "credential" | "transport"; cause: unknown }) => void;
};
const fakeState: {
  lastConfig?: FakeConfig;
  startError: unknown;
  typedThread?: string;
  sent: Array<{ channelUserId: string; threadId: string; message: unknown }>;
  historyCalls: Array<{ threadId: string | null; windowHours: number }>;
  historyMessages: NormalizedMessage[];
  apiRequests: ChannelApiRequest[];
  apiResult: ChannelApiResult;
  stopCalls: number;
  channels: Array<{
    id: string;
    name: string;
    guildId: string;
    guildName: string;
    type: "text" | "thread";
    parentId?: string;
  }>;
} = {
  startError: null,
  sent: [],
  historyCalls: [],
  historyMessages: [],
  apiRequests: [],
  apiResult: { response: { status: 200, headers: {}, body: { ok: true } } },
  stopCalls: 0,
  channels: [],
};

rs.mock("../../channels/discord.js", () => ({
  DiscordAdapter: class {
    constructor(readonly config: FakeConfig) {
      fakeState.lastConfig = config;
    }
    onMessage(): void {}
    async start(): Promise<void> {
      if (fakeState.startError) throw fakeState.startError;
    }
    async stop(): Promise<void> {
      fakeState.stopCalls++;
    }
    async sendMessage(channelUserId: string, threadId: string, message: unknown): Promise<void> {
      fakeState.sent.push({ channelUserId, threadId, message });
    }
    async saveIncomingAttachments(msg: { attachments: unknown[] }): Promise<unknown[]> {
      return msg.attachments;
    }
    async fetchHistory(threadId: string | null, windowHours: number): Promise<NormalizedMessage[]> {
      fakeState.historyCalls.push({ threadId, windowHours });
      return fakeState.historyMessages;
    }
    async notifyTyping(threadId: string): Promise<void> {
      fakeState.typedThread = threadId;
    }
    listGuildChannels() {
      return fakeState.channels;
    }
    async executeApiRequest(request: ChannelApiRequest) {
      fakeState.apiRequests.push(request);
      return fakeState.apiResult;
    }
  },
}));

// Import AFTER the mock is registered.
const { makeDiscordDescriptor, isDiscordAuthError } = await import("./discord.js");

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const deps = {
  conversationSettings: {} as never,
  personMappingRepo: { findByChannelUser: rs.fn(async () => null) } as never,
  listAgents: () => [],
  validateToken: async () => {},
};

const validCred = () => ({ material: { token: "bot-token" }, expiresAt: "never" as const });

// DiscordjsError's constructor is `private` in the typings (it's an internal
// factory type), so construct a genuine instance via Reflect.construct — real
// enough for `instanceof DiscordjsError` in isDiscordAuthError, without the
// TS2673 private-constructor error a `new DiscordjsError(...)` call raises.
function discordError(code: DiscordjsErrorCodes): DiscordjsError {
  return Reflect.construct(DiscordjsError, [code]) as DiscordjsError;
}

function buildTalker(startError: unknown = null): {
  talker: Talker;
  faults: StreamFault[];
  start: () => void;
} {
  fakeState.startError = startError;
  const desc = makeDiscordDescriptor(deps);
  const talker = desc.capabilities.talker!.build(
    { bot: validCred() },
    {
      connectionId: "discord-test",
      persist: async () => {},
      registerIngress: () => () => {},
    },
  );
  const faults: StreamFault[] = [];
  return {
    talker,
    faults,
    start: () =>
      talker.start(
        () => {},
        (err) => faults.push(err),
      ),
  };
}

beforeEach(() => {
  fakeState.lastConfig = undefined;
  fakeState.startError = null;
  fakeState.typedThread = undefined;
  fakeState.sent = [];
  fakeState.historyCalls = [];
  fakeState.historyMessages = [];
  fakeState.apiRequests = [];
  fakeState.apiResult = { response: { status: 200, headers: {}, body: { ok: true } } };
  fakeState.stopCalls = 0;
  fakeState.channels = [];
});

describe("isDiscordAuthError", () => {
  it("is true only for TokenInvalid / DisallowedIntents DiscordjsErrors", () => {
    expect(isDiscordAuthError(discordError(DiscordjsErrorCodes.TokenInvalid))).toBe(true);
    expect(isDiscordAuthError(discordError(DiscordjsErrorCodes.DisallowedIntents))).toBe(true);
    expect(isDiscordAuthError(discordError(DiscordjsErrorCodes.ClientNotReady))).toBe(false);
    expect(isDiscordAuthError(new Error("ECONNRESET"))).toBe(false);
    expect(isDiscordAuthError(undefined)).toBe(false);
  });
});

describe("discord descriptor shape", () => {
  it("declares one `bot` grant and a talker needing it", () => {
    const desc = makeDiscordDescriptor(deps);
    expect(desc.service).toBe("discord");
    expect(Object.keys(desc.auth)).toEqual(["bot"]);
    expect(desc.capabilities.talker?.needs).toEqual(["bot"]);
    expect(desc.capabilities.actor?.needs).toEqual(["bot"]);
    expect(desc.capabilities.watcher).toBeUndefined();
  });

  it("runs the injected token validator on confer", async () => {
    const validate = rs.fn(async () => {});
    const desc = makeDiscordDescriptor({ ...deps, validateToken: validate });
    await desc.auth.bot.confer({
      prompt: async () => ({ token: "abc" }),
    });
    expect(validate).toHaveBeenCalledWith("abc");
  });

  it("exposes inbound media and returns an awaitable stop()", async () => {
    const h = buildTalker();
    h.start();
    const inboundMedia = h.talker.feature("inboundMedia");
    const message = {
      messageId: "message-1",
      conversationId: "chan-1" as ConversationId,
      senderId: "user-1",
      text: "hi",
      attachments: [],
      timestamp: new Date(),
      raw: { channel: "discord", rawEvent: null, attachments: [] },
    } satisfies InboundMessage;
    await expect(inboundMedia?.materialize(message)).resolves.toEqual([]);
    const stopped = h.talker.stop();
    expect(stopped).toBeInstanceOf(Promise);
    await stopped;
  });

  it("passes the opaque conversation id to the adapter", async () => {
    const h = buildTalker();
    h.start();
    await h.talker.send("chan-1" as ConversationId, { text: "hi" });
    expect(fakeState.sent).toEqual([
      { channelUserId: "chan-1", threadId: "chan-1", message: { text: "hi" } },
    ]);
  });

  it("exposes provider-neutral history", async () => {
    fakeState.historyMessages = [
      {
        id: "message-1",
        channel: "discord",
        channelUserId: "user-1",
        displayName: "User",
        threadId: "chan-1",
        threadType: "group",
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        text: "hello",
        attachments: [],
        rawEvent: {},
      },
    ];
    const h = buildTalker();
    h.start();
    await expect(
      h.talker.feature("history")?.query({
        conversationId: "chan-1" as ConversationId,
      }),
    ).resolves.toMatchObject([{ messageId: "message-1", text: "hello" }]);
    expect(fakeState.historyCalls).toEqual([{ threadId: "chan-1", windowHours: 24 }]);
  });

  it("exposes provider-neutral activity", async () => {
    const h = buildTalker();
    h.start();
    const session = await h.talker
      .feature("activity")
      ?.begin({ conversationId: "chan-2" as ConversationId });
    await session?.update("working");
    expect(fakeState.typedThread).toBe("chan-2");
  });

  it("exposes stable opaque directory ids with provider-local pagination", async () => {
    fakeState.channels = Array.from({ length: 3 }, (_, index) => ({
      id: `channel-${index}`,
      name: `channel-${index}`,
      guildId: "guild-1",
      guildName: "Rome",
      type: "text" as const,
    }));
    const directory = buildTalker().talker.feature("directory");

    const first = await directory?.listConversations({ limit: 2 });
    expect(first?.conversations.map((entry) => entry.ref)).toEqual([
      { connectionId: "discord-test", conversationId: "channel-0" },
      { connectionId: "discord-test", conversationId: "channel-1" },
    ]);
    expect(first?.nextCursor).toBeTruthy();

    const second = await directory?.listConversations({
      limit: 2,
      cursor: first?.nextCursor,
    });
    expect(second?.conversations.map((entry) => entry.ref.conversationId)).toEqual(["channel-2"]);
    expect(second?.nextCursor).toBeUndefined();
  });

  it("exposes Discord REST through Act", async () => {
    const desc = makeDiscordDescriptor(deps);
    const actor = desc.capabilities.actor!.build(
      { bot: validCred() },
      {
        connectionId: "discord-test",
        persist: async () => {},
        registerIngress: () => () => {},
      },
    );
    const request: ChannelApiRequest = {
      method: "GET",
      path: "/users/@me",
      query: [],
      headers: {},
      body: null,
      timeoutMs: 30_000,
    };
    await expect(
      actor.invoke({ operation: "discord.api.request", input: request }),
    ).resolves.toEqual({
      response: { status: 200, headers: {}, body: { ok: true } },
    });
    expect(fakeState.apiRequests).toEqual([request]);
  });

  it("rejects a Discord REST 401 as a credential fault and tears down actor work", async () => {
    fakeState.apiResult = {
      response: { status: 401, headers: {}, body: { message: "Unauthorized" } },
    };
    const actor = makeDiscordDescriptor(deps).capabilities.actor!.build(
      { bot: validCred() },
      {
        connectionId: "discord-test",
        persist: async () => {},
        registerIngress: () => () => {},
      },
    );

    const request = actor.invoke({
      operation: "discord.api.request",
      input: {
        method: "GET",
        path: "/users/@me",
        query: [],
        headers: {},
        body: null,
        timeoutMs: 30_000,
      } satisfies ChannelApiRequest,
    });

    await expect(request).rejects.toMatchObject({ name: "CredentialRejected", grant: "bot" });
    await actor.stop?.();
    expect(fakeState.stopCalls).toBe(1);
  });
});

describe("discord Talker fault mapping", () => {
  it("maps a login TokenInvalid to CredentialRejected{ grant: 'bot' }", async () => {
    const h = buildTalker(discordError(DiscordjsErrorCodes.TokenInvalid));
    h.start();
    await flush();
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("bot");
  });

  it("maps a login DisallowedIntents to CredentialRejected{ grant: 'bot' }", async () => {
    const h = buildTalker(discordError(DiscordjsErrorCodes.DisallowedIntents));
    h.start();
    await flush();
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("bot");
  });

  it("maps a non-auth login failure to Disconnected", async () => {
    const h = buildTalker(new Error("ECONNRESET"));
    h.start();
    await flush();
    expect(h.faults[0]).toBeInstanceOf(Disconnected);
    expect(h.faults[0]).not.toBeInstanceOf(CredentialRejected);
  });

  it("routes a live 'credential' gateway fault to CredentialRejected{ grant: 'bot' }", async () => {
    const h = buildTalker();
    h.start();
    fakeState.lastConfig?.onGatewayFault?.({ kind: "credential", cause: new Error("invalidated") });
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("bot");
  });

  it("routes a live 'transport' gateway fault to Disconnected", async () => {
    const h = buildTalker();
    h.start();
    fakeState.lastConfig?.onGatewayFault?.({ kind: "transport", cause: new Error("shard died") });
    expect(h.faults[0]).toBeInstanceOf(Disconnected);
    expect(h.faults[0]).not.toBeInstanceOf(CredentialRejected);
  });
});
