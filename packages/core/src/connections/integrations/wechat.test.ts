// The WeChat descriptor. Three layers under test:
//   1. isWechatAuthError / descriptor shape — pure, no transport.
//   2. Talker fault mapping — a fake WechatAdapter (injected through the
//      createAdapter seam) fires its onFault callback so we assert HTTP 401/403
//      → CredentialRejected{ grant: "account" } and other terminal → Disconnected.
//   3. The account-401 → renew-once-then-degrade flow end-to-end over the real
//      ConnectionRegistry (the route-driven scheme's renew answers "re-confer").

import { afterEach, describe, expect, it } from "@rstest/core";
import type { ConversationId, InboundMessage, NormalizedMessage } from "@rome-os/app-runtime";
import { createTestDb } from "../../test/helpers.js";
import type { WechatAdapterConfig } from "../../channels/wechat.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import type { Connection, StreamFault, Talk, Talker } from "../types.js";
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
  handler?: (msg: NormalizedMessage) => Promise<void>;
  started = false;
  stopped = false;
  readonly sent: Array<{ channelUserId: string; threadId: string; text?: string }> = [];
  readonly typed: string[] = [];
  degradation: { reason: string; retryAt: string } | null = null;
  private readonly onFault?: (err: unknown) => void;

  constructor(config: WechatAdapterConfig) {
    this.onFault = config.onFault;
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.handler = handler;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async sendMessage(
    channelUserId: string,
    threadId: string,
    message: { text?: string },
  ): Promise<void> {
    this.sent.push({ channelUserId, threadId, text: message.text });
  }
  async saveIncomingAttachments(msg: NormalizedMessage) {
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
    expect(conn.talk).toBeNull();
  });

  it("unlocks talk and forwards attachments + typing once the grant is imported", async () => {
    const { registry, adapters } = setup();
    const conn = await registry.connect("wechat");
    await registry.importCredential(conn.id, "account", validCred());

    expect(conn.status().talk).toEqual({ state: "unlocked" });
    expect(conn.talk).not.toBeNull();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].started).toBe(true);

    await conn.talk!.send("addr-1" as ConversationId, { text: "hi" });
    expect(adapters[0].sent).toEqual([{ channelUserId: "addr-1", threadId: "addr-1", text: "hi" }]);
    const inboundMedia = conn.talk!.feature("inboundMedia");
    const message = {
      messageId: "message-1",
      conversationId: "addr-1" as ConversationId,
      senderId: "user-1",
      text: "hi",
      attachments: [],
      timestamp: new Date(),
      raw: { channel: "wechat", rawEvent: null, attachments: [] },
    } satisfies InboundMessage;
    await expect(inboundMedia?.materialize(message)).resolves.toEqual([]);
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
    expect(conn.talk).not.toBeNull();
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

    expect(conn.talk).toBeNull();
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
    void (conn.talk as Talk | null);
  });
});
