// The Feishu descriptor. Layers under test:
//   1. isFeishuAuthError / descriptor shape — pure, no transport.
//   2. credentialsPaste confer: a transient connect validates the pasted app
//      credentials (bad creds → connect rejects → confer refuses).
//   3. Talker fault mapping via a fake LarkChannel (injected through
//      createChannel): a bad-credential connect at start → CredentialRejected,
//      an `error` event → CredentialRejected (auth) or Disconnected (transport).
//   4. inbound/outbound messages map through the provider-neutral Talk handle.

import { afterEach, describe, expect, it } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import {
  type CardActionEvent,
  LarkChannelError,
  type NormalizedMessage as LarkMessage,
  type SendInput,
  type SendOptions,
} from "@larksuiteoapi/node-sdk";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { isFeishuAuthError } from "../../channels/feishu.js";
import { createTestDb } from "../../test/helpers.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import type { Connection, StreamFault, Talker } from "../types.js";
import { createFeishuDescriptor, feishuRegistrationAddons } from "./feishu.js";

// A fresh drizzle-backed ledger per test; opened DBs are closed after each test.
const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake LarkChannel: captures event handlers, records sends, and lets a test
 *  reject connect() (bad credentials) or fire an `error` event on demand. */
class FakeLarkChannel {
  handlers = new Map<string, (arg: unknown) => unknown>();
  sent: Array<{ to: string; input: SendInput; opts?: SendOptions }> = [];
  addedReactions: Array<{ messageId: string; emojiType: string; reactionId: string }> = [];
  removedReactions: Array<{ messageId: string; reactionId: string }> = [];
  connected = false;
  botIdentity = { openId: "ou_bot", name: "Rome" };
  connectError: Error | null = null;

  on(name: string, handler: (arg: unknown) => unknown): () => void {
    this.handlers.set(name, handler);
    return () => this.handlers.delete(name);
  }
  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async send(to: string, input: SendInput, opts?: SendOptions) {
    this.sent.push({ to, input, opts });
    return { messageId: "om_sent" };
  }
  async updateCard(): Promise<void> {}
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const reactionId = `reaction-${this.addedReactions.length + 1}`;
    this.addedReactions.push({ messageId, emojiType, reactionId });
    return reactionId;
  }
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.removedReactions.push({ messageId, reactionId });
  }
  emitError(err: unknown): void {
    const handler = this.handlers.get("error");
    if (!handler) throw new Error("no error handler registered");
    handler(err);
  }
  async emitMessage(over: Partial<LarkMessage> = {}): Promise<void> {
    const handler = this.handlers.get("message");
    if (!handler) throw new Error("no message handler registered");
    await handler({
      messageId: "om_1",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_alice",
      senderName: "Alice",
      content: "hi",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1700000000000,
      ...over,
    } as LarkMessage);
  }
}

function fakePersonRepo(): PersonMappingRepository {
  return {
    findByChannelUser: async () => null,
    findByBondLevel: async () => [],
    addChannelMapping: async () => "id",
  } as unknown as PersonMappingRepository;
}

function makeDescriptor(channel: FakeLarkChannel) {
  return createFeishuDescriptor({
    conversationSettings: {
      observe: () => {},
      get: async () => ({
        effective: {
          enabled: true,
          activation: {
            mode: "mention",
            botMessages: "ignore",
            whenOthersMentioned: "ignore",
          },
          replies: { placement: "thread" },
          routing: { agentName: null },
        },
        overrides: {},
        inherited: {},
        supportedFields: ["enabled", "activation.mode", "replies.placement", "routing.agentName"],
      }),
    } as never,
    personMappingRepo: fakePersonRepo(),
    listAgents: () => ["main"],
    createChannel: () => channel as never,
  });
}

const validCred = () => ({
  material: { appId: "cli_x", appSecret: "s3cr3t", domain: "feishu" },
  expiresAt: "never" as const,
});

describe("isFeishuAuthError", () => {
  it("is true for a permission_denied LarkChannelError and Feishu auth codes", () => {
    expect(isFeishuAuthError(new LarkChannelError("permission_denied", "denied"))).toBe(true);
    expect(isFeishuAuthError({ code: 99991663, message: "tenant token" })).toBe(true);
    expect(isFeishuAuthError({ code: 10003 })).toBe(true);
    expect(isFeishuAuthError(new Error("invalid app_secret"))).toBe(true);
  });

  it("is false for transport errors and unrelated codes", () => {
    expect(isFeishuAuthError(new LarkChannelError("send_timeout", "timed out"))).toBe(false);
    expect(isFeishuAuthError(new LarkChannelError("not_connected", "no ws"))).toBe(false);
    expect(isFeishuAuthError({ code: 500 })).toBe(false);
    expect(isFeishuAuthError(new Error("ECONNRESET"))).toBe(false);
    expect(isFeishuAuthError(undefined)).toBe(false);
  });
});

describe("feishu descriptor shape", () => {
  it("declares one `app` grant and a talker needing it", () => {
    const desc = makeDescriptor(new FakeLarkChannel());
    expect(desc.service).toBe("feishu");
    expect(Object.keys(desc.auth)).toEqual(["app"]);
    expect(desc.capabilities.talker?.needs).toEqual(["app"]);
    expect(desc.capabilities.actor).toBeUndefined();
    expect(desc.capabilities.watcher).toBeUndefined();
  });

  it("requests permission to add and remove processing reactions", () => {
    expect(feishuRegistrationAddons().scopes.tenant).toContain("im:message.reactions:write_only");
  });

  it("validates pasted credentials via a transient connect (bad creds refused)", async () => {
    const channel = new FakeLarkChannel();
    channel.connectError = new LarkChannelError("permission_denied", "bad app secret");
    const scheme = makeDescriptor(channel).auth.app;
    await expect(
      scheme.confer({
        prompt: async () => ({ appId: "cli_x", appSecret: "wrong", domain: "feishu" }),
      }),
    ).rejects.toBeInstanceOf(LarkChannelError);
    // Even on failure the transient channel is torn down.
    expect(channel.connected).toBe(false);
  });

  it("confers a non-expiring credential from a good connect", async () => {
    const channel = new FakeLarkChannel();
    const scheme = makeDescriptor(channel).auth.app;
    const cred = await scheme.confer({
      prompt: async () => ({ appId: "cli_x", appSecret: "s3cr3t", domain: "feishu" }),
    });
    expect(cred).toEqual({
      material: { appId: "cli_x", appSecret: "s3cr3t", domain: "feishu" },
      expiresAt: "never",
    });
  });
});

describe("feishu talk lifecycle", () => {
  it("unlocks talk, connects the channel, and delivers inbound once the grant is imported", async () => {
    const channel = new FakeLarkChannel();
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeDescriptor(channel));
    const conn = await registry.connect("feishu");
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["app"] });

    await registry.importCredential(conn.id, "app", validCred());
    await flush();
    expect(conn.status().talk).toEqual({ state: "unlocked" });
    expect(channel.connected).toBe(true);

    const received: string[] = [];
    conn.talk!.subscribe(async (msg) => {
      received.push(`${msg.senderId}/${msg.conversationId}:${msg.text}`);
      return;
    });
    await channel.emitMessage({ content: "hello there" });
    expect(received).toEqual(["ou_alice/oc_chat:hello there"]);

    await expect(conn.talk!.send("oc_chat" as ConversationId, { text: "reply" })).resolves.toEqual({
      messageId: "om_sent",
      conversationId: "oc_chat",
    });

    const activity = conn.talk!.feature("activity");
    const session = await activity?.begin({
      conversationId: "oc_chat" as ConversationId,
      messageId: "om_1",
    });
    await session?.finish("done");
    expect(channel.addedReactions).toEqual([
      { messageId: "om_1", emojiType: "Typing", reactionId: "reaction-1" },
    ]);
    expect(channel.removedReactions).toEqual([{ messageId: "om_1", reactionId: "reaction-1" }]);
  });
});

// Direct-Talker harness for the raw start()/fault() contract.
function buildTalker(channel: FakeLarkChannel): { talker: Talker; faults: StreamFault[] } {
  const talker = makeDescriptor(channel).capabilities.talker!.build(
    { app: validCred() },
    {
      connectionId: "feishu-test",
      persist: async () => {},
      registerIngress: () => () => {},
    },
  );
  const faults: StreamFault[] = [];
  talker.start(
    () => {},
    (err) => faults.push(err),
  );
  return { talker, faults };
}

describe("feishu Talker fault mapping", () => {
  it("maps a bad-credential connect at start to CredentialRejected{ grant: 'app' }", async () => {
    const channel = new FakeLarkChannel();
    channel.connectError = new LarkChannelError("permission_denied", "denied");
    const h = buildTalker(channel);
    await flush();
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("app");
  });

  it("maps a transport error event to Disconnected", async () => {
    const channel = new FakeLarkChannel();
    const h = buildTalker(channel);
    await flush();
    channel.emitError(new LarkChannelError("not_connected", "ws dropped"));
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(Disconnected);
    expect(h.faults[0]).not.toBeInstanceOf(CredentialRejected);
  });

  it("maps an auth error event to CredentialRejected{ grant: 'app' }", async () => {
    const channel = new FakeLarkChannel();
    const h = buildTalker(channel);
    await flush();
    channel.emitError(new LarkChannelError("permission_denied", "revoked"));
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("app");
  });
});

describe("feishu app-auth fault drives renew-once-then-degrade", () => {
  it("relocks talk after an auth error (credentialsPaste renew answers re-confer)", async () => {
    const channel = new FakeLarkChannel();
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeDescriptor(channel));
    const conn = await registry.connect("feishu");
    await registry.importCredential(conn.id, "app", validCred());
    await flush();
    expect(conn.status().talk).toEqual({ state: "unlocked" });

    channel.emitError(new LarkChannelError("permission_denied", "revoked"));
    await flush();

    expect(conn.talk).toBeNull();
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["app"] });
    expect(conn.auth.grants().app).toBe("degraded");

    let reUnlocked: Connection | null = null;
    registry.onUnlocked("talk", (c) => {
      reUnlocked = c;
    });
    channel.connectError = null;
    await registry.importCredential(conn.id, "app", {
      material: { appId: "cli_x", appSecret: "fresh", domain: "feishu" },
      expiresAt: "never",
    });
    await flush();
    expect(conn.status().talk).toEqual({ state: "unlocked" });
    expect(reUnlocked).not.toBeNull();
  });
});

// Silence unused import warnings for the SDK types re-exported by the descriptor.
export type { CardActionEvent };
