// The Telegram descriptor. Two layers under test:
//   1. isTelegramAuthError / descriptor shape — pure, no transport.
//   2. fault mapping through a REAL grammy Bot: a local transformer fake
//      (same seam as test/kit/fake-telegram.ts) answers getMe/getUpdates/
//      sendMessage with canned wire JSON, so grammy's own client turns an
//      { ok: false, error_code } into a real GrammyError. We assert those
//      surface as CredentialRejected{ grant: "bot" } (401) or Disconnected
//      (network), and drive the send-401 → renew-once-then-degrade flow
//      end-to-end over the real ConnectionRegistry.

import { afterEach, describe, expect, it } from "@rstest/core";
import type { ConversationId, InboundMessage } from "@rome-os/app-runtime";
import { Bot, GrammyError, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createTestDb } from "../../test/helpers.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import type { Connection, StreamFault, Talk, Talker } from "../types.js";
import { isTelegramAuthError, makeTelegramDescriptor } from "./telegram.js";

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

// A macrotask flush: lets the registry's async `void handle…` fault flows
// (renew-once-then-degrade over the ledger) settle before assertions run.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const BOT_INFO: UserFromGetMe = {
  id: 424242,
  is_bot: true,
  first_name: "FaultBot",
  username: "fault_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

type Answer =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string };

/**
 * A configurable grammy transport fake wired through the transformer seam.
 * `getMe`/`getUpdates`/`sendMessage` each consult an overridable responder so a
 * test can inject a 401 (→ GrammyError) or a thrown network error (→ HttpError).
 * With `skipInit: true`, `botInfo` is passed so `bot.init()` never calls getMe
 * (the happy-path start); otherwise init runs getMe against the fake.
 */
class FaultBotFactory {
  /** Tokens seen, in construction order. */
  readonly tokens: string[] = [];
  /** Recorded outbound send-family calls. */
  readonly sent: Array<{ method: string; payload: Record<string, unknown> }> = [];

  private bot?: Bot;
  private polling = false;
  private pollingWaiters: (() => void)[] = [];
  private nextUpdateId = 1;

  /** Overridable responders. Default: happy path. */
  getMe: () => Answer = () => ({ ok: true, result: BOT_INFO });
  /** When set, getMe throws (→ grammy HttpError, a non-auth transport failure). */
  getMeThrow: (() => Error) | null = null;
  sendMessage: () => Answer = () => ({
    ok: true,
    result: { message_id: 1, date: 0, chat: { id: 0, type: "private", first_name: "c" } },
  });
  /** When set, getUpdates answers with this error JSON (→ GrammyError). */
  getUpdatesError: (() => Answer) | null = null;

  constructor(private readonly skipInit: boolean) {}

  readonly createBot = (token: string): Bot => {
    this.tokens.push(token);
    const bot = this.skipInit ? new Bot(token, { botInfo: BOT_INFO }) : new Bot(token);
    bot.api.config.use(((_prev: unknown, method: string, payload: unknown, signal?: AbortSignal) =>
      this.answer(method, payload, signal)) as unknown as Transformer);
    this.bot = bot;
    return bot;
  };

  private async answer(method: string, payload: unknown, signal?: AbortSignal): Promise<Answer> {
    switch (method) {
      case "getMe":
        if (this.getMeThrow) throw this.getMeThrow();
        return this.getMe();
      case "deleteWebhook":
        return { ok: true, result: true };
      case "getUpdates":
        return this.longPoll(signal);
      case "sendMessage": {
        this.sent.push({ method, payload: payload as Record<string, unknown> });
        return this.sendMessage();
      }
      default:
        return { ok: true, result: true };
    }
  }

  private longPoll(signal?: AbortSignal): Promise<Answer> {
    // The offset-confirming final getUpdates (no signal) resolves immediately.
    if (!signal) return Promise.resolve({ ok: true, result: [] });
    if (this.getUpdatesError) return Promise.resolve(this.getUpdatesError());
    this.polling = true;
    this.pollingWaiters.splice(0).forEach((wake) => wake());
    return new Promise((_resolve, reject) => {
      const abort = () => {
        this.polling = false;
        const err = new Error("getUpdates aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  untilPolling(): Promise<void> {
    if (this.polling) return Promise.resolve();
    return new Promise((resolve) => this.pollingWaiters.push(resolve));
  }

  async emitUpdate(update: Record<string, unknown>): Promise<void> {
    if (!this.bot || !this.polling) throw new Error("not polling");
    await this.bot.handleUpdate({ update_id: this.nextUpdateId++, ...update } as unknown as Update);
  }
}

/** Build a real registry with the telegram descriptor over the given factory. */
function setup(factory: FaultBotFactory): ConnectionRegistry {
  const registry = new ConnectionRegistry({ ledger: makeLedger() });
  registry.register(makeTelegramDescriptor({ createBot: factory.createBot }));
  return registry;
}

const validCred = () => ({ material: { token: "bot-token" }, expiresAt: "never" as const });

describe("isTelegramAuthError", () => {
  it("is true only for a GrammyError with error_code 401", () => {
    const unauthorized = new GrammyError(
      "Call to 'getMe' failed!",
      { ok: false, error_code: 401, description: "Unauthorized" },
      "getMe",
      {},
    );
    expect(isTelegramAuthError(unauthorized)).toBe(true);

    const rateLimited = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 429, description: "Too Many Requests" },
      "sendMessage",
      {},
    );
    expect(isTelegramAuthError(rateLimited)).toBe(false);
    expect(isTelegramAuthError(new Error("boom"))).toBe(false);
    expect(isTelegramAuthError(undefined)).toBe(false);
  });
});

describe("telegram descriptor shape", () => {
  it("declares one `bot` grant and a talker needing it", () => {
    const desc = makeTelegramDescriptor();
    expect(desc.service).toBe("telegram");
    expect(Object.keys(desc.auth)).toEqual(["bot"]);
    expect(desc.capabilities.talker?.needs).toEqual(["bot"]);
    expect(desc.capabilities.actor).toBeUndefined();
    expect(desc.capabilities.watcher).toBeUndefined();
  });

  it("exposes an awaitable stop() and forwards saveIncomingAttachments", () => {
    const factory = new FaultBotFactory(true);
    const desc = makeTelegramDescriptor({ createBot: factory.createBot });
    const talker = desc.capabilities.talker!.build(
      { bot: validCred() },
      {
        connectionId: "telegram-test",
        persist: async () => {},
        registerIngress: () => () => {},
      },
    );
    // stop() returns the adapter's drain promise so registry.stopAll can await
    // grammy's bot.stop() letting in-flight sends / the long-poll finish.
    talker.start(
      () => {},
      () => {},
    );
    const stopped = talker.stop();
    expect(stopped).toBeInstanceOf(Promise);
    const message = {
      messageId: "message-1",
      conversationId: "999" as ConversationId,
      senderId: "111",
      text: "hi",
      attachments: [],
      timestamp: new Date(),
      raw: { channel: "telegram", rawEvent: null, attachments: [] },
    } satisfies InboundMessage;
    void talker.feature("inboundMedia")?.materialize(message);
    return stopped as Promise<void>;
  });

  it("reports needs-auth for talk before the bot grant is conferred", async () => {
    const factory = new FaultBotFactory(true);
    const registry = setup(factory);
    const conn = await registry.connect("telegram");
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
    expect(conn.talk).toBeNull();
  });

  it("unlocks talk once the bot grant is imported and delivers inbound", async () => {
    const factory = new FaultBotFactory(true);
    const registry = setup(factory);
    const conn = await registry.connect("telegram");
    await registry.importCredential(conn.id, "bot", validCred());

    expect(conn.status().talk).toEqual({ state: "unlocked" });
    const talk = conn.talk;
    expect(talk).not.toBeNull();

    const received: string[] = [];
    talk!.subscribe(async (msg) => {
      received.push(`${msg.conversationId}:${msg.text}`);
      return;
    });
    await factory.untilPolling();
    await factory.emitUpdate({
      message: {
        message_id: 7,
        date: 1700000000,
        text: "hi",
        from: { id: 111, is_bot: false, first_name: "Alice" },
        chat: { id: 999, type: "private" },
      },
    });
    expect(received).toEqual(["999:hi"]);

    await talk!.send("999" as ConversationId, { text: "yo" });
    expect(factory.sent).toEqual([
      { method: "sendMessage", payload: { chat_id: "999", text: "yo", parse_mode: "HTML" } },
    ]);
  });
});

// A direct-Talker harness for the raw start()/fault() contract, bypassing the
// registry so we observe exactly what the builder reports.
function buildTalker(factory: FaultBotFactory): {
  talker: Talker;
  faults: StreamFault[];
  start: () => void;
} {
  const desc = makeTelegramDescriptor({ createBot: factory.createBot });
  const talker = desc.capabilities.talker!.build(
    { bot: validCred() },
    {
      connectionId: "telegram-test",
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

describe("telegram Talker fault mapping", () => {
  it("maps a 401 at start (getMe/init) to CredentialRejected{ grant: 'bot' }", async () => {
    const factory = new FaultBotFactory(/* skipInit */ false);
    factory.getMe = () => ({ ok: false, error_code: 401, description: "Unauthorized" });
    const h = buildTalker(factory);

    h.start();
    await flush();

    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("bot");
  });

  it("maps a 401 from the getUpdates poll to CredentialRejected{ grant: 'bot' }", async () => {
    const factory = new FaultBotFactory(/* skipInit */ true);
    factory.getUpdatesError = () => ({ ok: false, error_code: 401, description: "Unauthorized" });
    const h = buildTalker(factory);

    h.start();
    await flush();

    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("bot");
  });

  it("maps a network failure to Disconnected (not a credential fault)", async () => {
    // A transport failure at init (getMe) — grammy wraps a thrown transformer
    // error as HttpError, NOT a 401 GrammyError, so bot.init() rejects
    // terminally and routeFault sees a non-auth error.
    const factory = new FaultBotFactory(/* skipInit */ false);
    factory.getMeThrow = () => new Error("ECONNRESET");
    const h = buildTalker(factory);

    h.start();
    await flush();

    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(Disconnected);
    expect(h.faults[0]).not.toBeInstanceOf(CredentialRejected);
  });

  it("throws CredentialRejected{ grant: 'bot' } from send() on a 401", async () => {
    const factory = new FaultBotFactory(/* skipInit */ true);
    factory.sendMessage = () => ({ ok: false, error_code: 401, description: "Unauthorized" });
    const h = buildTalker(factory);
    h.start();

    const addr = "999" as ConversationId;
    await expect(h.talker.send(addr, { text: "hi" })).rejects.toBeInstanceOf(CredentialRejected);
    await expect(h.talker.send(addr, { text: "hi" })).rejects.toMatchObject({ grant: "bot" });
  });
});

describe("telegram send-401 drives renew-once-then-degrade", () => {
  it("relocks talk after a send() 401 (tokenPaste renew answers re-confer)", async () => {
    const factory = new FaultBotFactory(/* skipInit */ true);
    factory.sendMessage = () => ({ ok: false, error_code: 401, description: "Unauthorized" });
    const registry = setup(factory);
    const conn = await registry.connect("telegram");
    await registry.importCredential(conn.id, "bot", validCred());

    expect(conn.status().talk).toEqual({ state: "unlocked" });
    const talk = conn.talk as Talk;

    // The send() 401 surfaces to the caller as CredentialRejected AND triggers
    // the async grant flow: tokenPaste.renew() → "re-confer" → degrade "bot".
    await expect(talk.send("999" as ConversationId, { text: "hi" })).rejects.toBeInstanceOf(
      CredentialRejected,
    );
    await flush();

    // Talk relocked; bot grant degraded (tokenPaste cannot renew headlessly).
    expect(conn.talk).toBeNull();
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["bot"] });
    expect(conn.auth.grants().bot).toBe("degraded");

    // Re-importing a credential re-unlocks talk (re-confer path).
    let reUnlocked: Connection | null = null;
    registry.onUnlocked("talk", (c) => {
      reUnlocked = c;
    });
    await registry.importCredential(conn.id, "bot", {
      material: { token: "fresh-token" },
      expiresAt: "never",
    });
    expect(conn.status().talk).toEqual({ state: "unlocked" });
    expect(reUnlocked).not.toBeNull();
  });
});
