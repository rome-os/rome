// The WeChat descriptor. Three layers under test:
//   1. isWechatAuthError / descriptor shape — pure, no transport.
//   2. Talker fault mapping — a fake WechatAdapter (injected through the
//      createAdapter seam) fires its onFault callback so we assert HTTP 401/403
//      → CredentialRejected{ grant: "account" } and other terminal → Disconnected.
//   3. The account-401 → renew-once-then-degrade flow end-to-end over the real
//      ConnectionRegistry (the route-driven scheme's renew answers "re-confer").
//   4. Inbound delivery over the real WechatAdapter, with ilinkai played by a
//      stubbed fetch.

import { mkdtemp, rm } from "node:fs/promises";
import { sendThrough } from "../../channels/connection-ports.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, ChannelMessage } from "@rome-os/app-runtime";
import { createTestDb } from "../../test/helpers.js";
import { WechatAdapter, type WechatAdapterConfig } from "../../channels/wechat.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import type { Connection, StreamFault, Talker } from "../types.js";
import { createWechatDescriptor } from "./wechat.js";

// A fresh drizzle-backed ledger per test (InMemoryGrantLedger left with p1);
// opened DBs are closed after each test.
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

/**
 * A fake WechatAdapter: records handler/lifecycle calls and exposes `fault()` to
 * fire the config's `onFault` seam on demand — the same seam the real adapter's
 * poll loop drives on a terminal outcome.
 */
class FakeWechatAdapter {
  handler?: (msg: ChannelMessage) => Promise<void>;
  started = false;
  stopped = false;
  readonly sent: Array<{ conversationId: ConversationId; text?: string }> = [];
  readonly typed: string[] = [];
  degradation: { reason: string; retryAt: string } | null = null;
  private readonly onFault?: (err: unknown) => void;

  constructor(config: WechatAdapterConfig) {
    this.onFault = config.onFault;
  }

  onInbound(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async send(conversationId: ConversationId, message: { text?: string }) {
    this.sent.push({ conversationId, text: message.text });
    return { conversationId };
  }
  async saveIncomingAttachments(msg: ChannelMessage) {
    return msg.attachments;
  }
  async notifyTyping(threadId: string): Promise<void> {
    this.typed.push(threadId);
  }
  getRuntimeDegradation(): { reason: string; retryAt: string } | null {
    return this.degradation;
  }
  /** Drive the fault seam. */
  fault(err: unknown): void {
    this.onFault?.(err);
  }
}

function setup(): { registry: ConnectionRegistry; adapters: FakeWechatAdapter[] } {
  const adapters: FakeWechatAdapter[] = [];
  const registry = new ConnectionRegistry({ ledger: makeLedger() });
  registry.register(
    createWechatDescriptor({
      createAdapter: (config) => {
        const adapter = new FakeWechatAdapter(config);
        adapters.push(adapter);
        return adapter as never;
      },
    }),
  );
  return { registry, adapters };
}

const validCred = () => ({
  material: { token: "wx-token", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "acc-1" },
  expiresAt: "never" as const,
});

describe("isWechatAuthError", () => {
  it("is true only for an HTTP 401/403 apiFetch error", async () => {
    const { isWechatAuthError } = await import("../../channels/wechat.js");
    expect(isWechatAuthError(new Error("HTTP 401: unauthorized"))).toBe(true);
    expect(isWechatAuthError(new Error("HTTP 403: forbidden"))).toBe(true);
    expect(isWechatAuthError(new Error("HTTP 500: boom"))).toBe(false);
    expect(isWechatAuthError(new Error("ECONNRESET"))).toBe(false);
    expect(isWechatAuthError(undefined)).toBe(false);
  });
});

describe("wechat descriptor shape", () => {
  it("declares one `account` grant and a talker needing it", () => {
    const desc = createWechatDescriptor();
    expect(desc.service).toBe("wechat");
    expect(Object.keys(desc.auth)).toEqual(["account"]);
    expect(desc.capabilities.talker?.needs).toEqual(["account"]);
    expect(desc.capabilities.actor).toBeUndefined();
    expect(desc.capabilities.watcher).toBeUndefined();
  });

  it("throws from confer (conferral is the setup) and re-confers on renew", async () => {
    const scheme = createWechatDescriptor().auth.account;
    await expect(scheme.confer({ prompt: async () => ({}) })).rejects.toThrow(
      "conferral driven by the connection setup",
    );
    // The setup is attached to the scheme (the generic routes discover it here).
    expect(scheme.setup).toBeTypeOf("function");
    await expect(scheme.renew({ material: {}, expiresAt: "never" })).resolves.toBe("re-confer");
  });

  it("reports needs-auth for talk before the account grant is imported", async () => {
    const { registry } = setup();
    const conn = await registry.connect("wechat");
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["account"] });
    expect(conn.isUnlocked("talk")).toBe(false);
  });

  it("unlocks talk and forwards attachments + typing once the grant is imported", async () => {
    const { registry, adapters } = setup();
    const conn = await registry.connect("wechat");
    await registry.importCredential(conn.id, "account", validCred());

    expect(conn.status().talk).toEqual({ state: "unlocked" });
    expect(conn.isUnlocked("talk")).toBe(true);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].started).toBe(true);

    await expect(sendThrough(conn, "addr-1" as ConversationId, { text: "hi" })).resolves.toEqual({
      conversationId: "addr-1",
    });
    expect(adapters[0].sent).toEqual([{ conversationId: "addr-1", text: "hi" }]);
    const message = {
      channel: "wechat",
      direction: "inbound",
      messageId: "message-1",
      conversationId: "addr-1" as ConversationId,
      senderId: "user-1",
      text: "hi",
      attachments: [],
      timestamp: new Date(),
    } satisfies ChannelMessage;
    await expect(
      conn.withTalker((talker) => talker.inboundMedia?.materialize(message)),
    ).resolves.toEqual([]);
  });

  it("reports transient adapter degradation without relocking the talk capability", async () => {
    const { registry, adapters } = setup();
    const conn = await registry.connect("wechat");
    await registry.importCredential(conn.id, "account", validCred());

    adapters[0].degradation = {
      reason: "WeChat reported a stale session.",
      retryAt: "2026-07-20T12:00:00.000Z",
    };

    expect(conn.status().talk).toEqual({
      state: "unlocked",
      degradation: {
        reason: "WeChat reported a stale session.",
        retryAt: "2026-07-20T12:00:00.000Z",
      },
    });
    expect(conn.isUnlocked("talk")).toBe(true);
    expect(conn.auth.grants().account).toBe("authorized");
  });
});

// Direct-Talker harness for the raw start()/fault() contract.
function buildTalker(): { talker: Talker; adapter: FakeWechatAdapter; faults: StreamFault[] } {
  let adapter!: FakeWechatAdapter;
  const desc = createWechatDescriptor({
    createAdapter: (config) => {
      adapter = new FakeWechatAdapter(config);
      return adapter as never;
    },
  });
  const talker = desc.capabilities.talker!.build(
    { account: validCred() },
    {
      connectionId: "wechat-test",
      persist: async () => {},
      registerIngress: () => () => {},
    },
  );
  const faults: StreamFault[] = [];
  talker.start(
    () => {},
    (err) => faults.push(err),
  );
  return { talker, adapter, faults };
}

describe("wechat Talker fault mapping", () => {
  it("maps an HTTP 401 poll failure to CredentialRejected{ grant: 'account' }", () => {
    const h = buildTalker();
    h.adapter.fault(new Error("HTTP 401: unauthorized"));
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("account");
  });

  it("maps a non-auth terminal failure to Disconnected", () => {
    const h = buildTalker();
    h.adapter.fault(new Error("HTTP 500: boom"));
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(Disconnected);
    expect(h.faults[0]).not.toBeInstanceOf(CredentialRejected);
  });
});

describe("wechat account-401 drives renew-once-then-degrade", () => {
  it("relocks talk after a terminal auth fault (route-driven renew answers re-confer)", async () => {
    const { registry, adapters } = setup();
    const conn = await registry.connect("wechat");
    await registry.importCredential(conn.id, "account", validCred());
    expect(conn.status().talk).toEqual({ state: "unlocked" });

    adapters[0].fault(new Error("HTTP 401: unauthorized"));
    await flush();

    expect(conn.isUnlocked("talk")).toBe(false);
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["account"] });
    expect(conn.auth.grants().account).toBe("degraded");

    // Re-importing (a fresh pairing) re-unlocks talk.
    let reUnlocked: Connection | null = null;
    registry.onUnlocked("talk", (c) => {
      reUnlocked = c;
    });
    await registry.importCredential(conn.id, "account", validCred());
    expect(conn.status().talk).toEqual({ state: "unlocked" });
    expect(reUnlocked).not.toBeNull();
  });
});

describe("wechat inbound delivery", () => {
  const originalFetch = globalThis.fetch;
  let statePath = "";
  afterEach(async () => {
    rs.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    if (statePath) await rm(statePath, { recursive: true, force: true });
    statePath = "";
  });

  it("delivers the transport's ChannelMessage as it is, and materializes media from raw", async () => {
    statePath = await mkdtemp(join(tmpdir(), "rome-wechat-delivery-"));
    // A group message that quotes an earlier message and carries an image, so
    // every optional field WeChat sets is present.
    const event = {
      message_id: 9001,
      from_user_id: "bob@im.wechat",
      group_id: "room-1@chatroom",
      message_type: 1,
      create_time_ms: 1700000000000,
      context_token: "ctx-1",
      item_list: [
        {
          type: 2,
          msg_id: "item-7",
          image_item: {
            width: 640,
            height: 480,
            media: { encrypt_query_param: "enc", aes_key: "00112233445566778899aabbccddeeff" },
          },
          ref_msg: {
            message_item: { type: 1, msg_id: "orig-1", text_item: { text: "original text" } },
          },
        },
      ],
    };
    const cdnRequests: string[] = [];
    let polls = 0;
    rs.stubGlobal(
      "fetch",
      rs.fn(async (url: string) => {
        if (url.includes("/ilink/bot/getupdates")) {
          polls += 1;
          // One batch, then a refused token so the poll loop ends.
          return polls === 1
            ? new Response(JSON.stringify({ ret: 0, msgs: [event] }), { status: 200 })
            : new Response("unauthorized", { status: 401 });
        }
        cdnRequests.push(url);
        return new Response("unavailable", { status: 503 });
      }),
    );

    const desc = createWechatDescriptor({ createAdapter: (config) => new WechatAdapter(config) });
    const talker = desc.capabilities.talker!.build(
      { account: { ...validCred(), material: { ...validCred().material, statePath } } },
      {
        connectionId: "wechat-test",
        persist: async () => {},
        registerIngress: () => () => {},
      },
    );
    const delivered: unknown[] = [];
    talker.start(
      (msg) => delivered.push(msg),
      () => {},
    );
    await rs.waitFor(() => expect(delivered).toHaveLength(1));

    expect(delivered).toStrictEqual([
      {
        channel: "wechat",
        direction: "inbound",
        messageId: "item-7",
        conversationId: "bob@im.wechat",
        senderId: "bob@im.wechat",
        senderDisplayName: "bob",
        text: "[Image (640x480)]",
        attachments: [
          {
            type: "image",
            url: "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=enc",
            fileName: "wechat-image.jpg",
            mimeType: "image/jpeg",
          },
        ],
        timestamp: new Date(1700000000000),
        replyTo: { messageId: "orig-1", content: "original text" },
        thread: { kind: "group", name: "room-1@chatroom" },
        addressing: "direct",
        raw: event,
      },
    ]);

    // Media reads its CDN reference from raw. A failed download leaves the
    // attachment unsaved rather than failing the message.
    const inboundMedia = talker.inboundMedia!;
    const message = delivered[0] as ChannelMessage;
    await expect(inboundMedia.materialize(message)).resolves.toStrictEqual(message.attachments);
    expect(cdnRequests).toEqual([
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=enc",
    ]);

    // Without the iLink event there is nothing to download with.
    const { raw: _raw, ...withoutRaw } = message;
    await expect(inboundMedia.materialize(withoutRaw)).resolves.toBe(withoutRaw.attachments);
    expect(cdnRequests).toHaveLength(1);

    await talker.stop();
  });
});
