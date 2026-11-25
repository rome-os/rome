import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId, InboundEvent } from "@rome-os/app-runtime";
import type { AccountLink } from "@rome/api-types/account-agents";
import type * as connections from "../../connections/message.js";
import type { ConnectionRegistry } from "../../connections/registry.js";
import { legacyMessage } from "../../connections/test-fixtures.js";
import {
  ACCOUNT_CODE_LIFETIME_MS,
  type AccountCodeContext,
  accountCodeContext,
  accountCodeIssued,
} from "../../identity/application/account-codes.js";
import { createIdentity } from "../../identity/identity.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { chatPromptFacts } from "../../core/chat-prompt-facts.js";
import {
  ACCOUNT_CODE_ANSWERS,
  accountCodeAdmission,
  withoutAccountCodes,
} from "./account-code-admission.js";
import { OrderedAdmission } from "./admission.js";
import { connectionPorts, type ConnectionPortsDeps } from "./connection-ports.js";

const ANN_SLACK = { platform: "slack", accountId: "T1:U7" };

function message(text: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "slack_app",
    direction: "inbound",
    messageId: "m1",
    chatId: "D1" as ChatId,
    senderId: ANN_SLACK.accountId,
    text,
    attachments: [],
    timestamp: new Date(0),
    thread: { kind: "dm" },
    ...overrides,
  };
}

describe("account code admission", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup(codes?: AccountCodeContext, connected = true) {
    testDb = createTestDb();
    const clock = { now: new Date("2026-11-25T10:00:00Z") };
    const ctx = codes ?? accountCodeContext(testDb.db, () => clock.now);
    const identity = createIdentity(testDb.db);
    // How Rome speaks on the connection: a Slack app is Rome's own account, a
    // signed-in Telegram is the guardian's, and WhatsApp takes no agent.
    let link: AccountLink | null = "own_account";
    const speakAs = (next: AccountLink | null) => {
      link = next;
    };
    const sent: Array<{ chatId: ChatId; text: string }> = [];
    const send = rs.fn(async (chatId: ChatId, out: { text?: string }) => {
      sent.push({ chatId, text: out.text ?? "" });
      return { messageId: "sent", chatId };
    });
    // `ConnectionRegistry.get` throws for a connection it no longer holds.
    const registry = {
      get: () => {
        if (!connected) throw new Error("Unknown connection conn");
        return { withTalker: (call: (talker: object) => unknown) => call({ send }) };
      },
    } as unknown as Pick<ConnectionRegistry, "get">;
    const admit = accountCodeAdmission({
      codes: ctx,
      linkOf: () => link,
      registry,
      platformOf: () => ANN_SLACK.platform,
    });
    // What a channel's subscribers hear, and so what Chats records.
    const heard: ChannelMessage[] = [];
    const ordered = new OrderedAdmission(admit);
    const deliver = (m: ChannelMessage) =>
      ordered.deliver({ id: "conn", connectionKind: "slack_app" }, m, async (h) => {
        heard.push(h);
      });
    const later = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    const answers = async (count: number) => {
      await rs.waitFor(() => expect(sent).toHaveLength(count));
      return sent.map((s) => s.text);
    };
    return { ctx, identity, deliver, heard, sent, answers, later, speakAs };
  }

  it("adds the sender's account to the code's person in a direct message, and answers there", async () => {
    const { ctx, identity, deliver, heard, sent, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await deliver(message(` ${code.toLowerCase()} `));

    expect((await identity.personOf(ANN_SLACK))?.id).toBe(ann.id);
    expect(await answers(1)).toEqual([ACCOUNT_CODE_ANSWERS.added]);
    expect(sent[0].chatId).toBe("D1");
    expect(heard).toEqual([]);
  });

  it("refuses the same code a second time and answers", async () => {
    const { ctx, identity, deliver, heard, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await deliver(message(code));
    await deliver(message(code, { messageId: "m2" }));

    expect(await answers(2)).toEqual([ACCOUNT_CODE_ANSWERS.added, ACCOUNT_CODE_ANSWERS.used]);
    expect(heard).toEqual([]);
  });

  it("refuses an expired code, adds nothing, and answers", async () => {
    const { ctx, identity, deliver, heard, answers, later } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(ctx, ann.id);
    later(ACCOUNT_CODE_LIFETIME_MS);

    await deliver(message(code));

    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(await answers(1)).toEqual([ACCOUNT_CODE_ANSWERS.expired]);
    expect(heard).toEqual([]);
  });

  it("answers a code Rome never issued", async () => {
    const { deliver, heard, answers } = setup();

    await deliver(message("ROME-222222-222222"));

    expect(await answers(1)).toEqual([ACCOUNT_CODE_ANSWERS.unknown]);
    expect(heard).toEqual([]);
  });

  it("refuses an account another person holds and leaves the code usable", async () => {
    const { ctx, identity, deliver, heard, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const bo = await identity.createPerson({ accounts: [ANN_SLACK] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await deliver(message(code));
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(bo.id);

    await deliver(message(code, { messageId: "m2", senderId: "T1:U8" }));
    expect((await identity.personOf({ platform: "slack", accountId: "T1:U8" }))?.id).toBe(ann.id);
    expect(await answers(2)).toEqual([ACCOUNT_CODE_ANSWERS.taken, ACCOUNT_CODE_ANSWERS.added]);
    expect(heard).toEqual([]);
  });

  it("voids a code said in a shared chat without answering, and the code then fails in a direct message", async () => {
    const { ctx, identity, deliver, heard, sent, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await deliver(message(code, { chatId: "C1" as ChatId, thread: { kind: "group" } }));
    expect(await identity.personOf(ANN_SLACK)).toBeNull();

    await deliver(message(code, { messageId: "m2" }));
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(await answers(1)).toEqual([ACCOUNT_CODE_ANSWERS.used]);
    expect(sent[0].chatId).toBe("D1");
    expect(heard).toEqual([]);
  });

  for (const link of ["delegate", null] as const) {
    it(`admits a code untouched on a connection where Rome has no own account (${link ?? "no agent"})`, async () => {
      const { ctx, identity, deliver, heard, sent, answers, speakAs } = setup();
      speakAs(link);
      const ann = await identity.createPerson({ accounts: [] });
      const { code } = await accountCodeIssued(ctx, ann.id);
      const direct = message(code);
      const shared = message(code, {
        messageId: "m2",
        chatId: "C1" as ChatId,
        thread: { kind: "group" },
      });

      await deliver(direct);
      await deliver(shared);

      expect(heard).toEqual([direct, shared]);
      expect(await identity.personOf(ANN_SLACK)).toBeNull();
      expect(sent).toEqual([]);
      // The code was neither redeemed nor voided, so it still works where Rome
      // has its own account.
      speakAs("own_account");
      await deliver(message(code, { messageId: "m3" }));
      expect(await answers(1)).toEqual([ACCOUNT_CODE_ANSWERS.added]);
    });
  }

  it("admits an ordinary message untouched, without a database read", async () => {
    const untouchable = new Proxy({} as AccountCodeContext, {
      get() {
        throw new Error("read the codes");
      },
    });
    const { deliver, heard, sent } = setup(untouchable);
    const ordinary = message("lunch at noon?");

    await deliver(ordinary);

    expect(heard).toEqual([ordinary]);
    expect(sent).toEqual([]);
  });

  it("admits a code inside a longer text as an ordinary message", async () => {
    const { ctx, identity, deliver, heard, sent } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await deliver(message(`my code is ${code}`));

    expect(heard.map((m) => m.text)).toEqual([`my code is ${code}`]);
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(sent).toEqual([]);
  });
  const group = (text: string, messageId: string): ChannelMessage =>
    message(text, { messageId, chatId: "G1" as ChatId, thread: { kind: "group" } });

  for (const [said, text] of [
    ["a mention, then the code, in a Telegram group", (code: string) => `@RomeBot ${code}`],
    ["the code inside a sentence", (code: string) => `my code is ${code}`],
  ] as const) {
    it(`voids ${said}, and hears the message as an ordinary one`, async () => {
      const { ctx, identity, deliver, heard, answers } = setup();
      const ann = await identity.createPerson({ accounts: [] });
      const { code } = await accountCodeIssued(ctx, ann.id);

      await deliver(group(text(code), "m1"));
      expect(heard.map((m) => m.text)).toEqual([text(code)]);

      await deliver(message(code, { messageId: "m2" }));
      expect(await identity.personOf(ANN_SLACK)).toBeNull();
      expect(await answers(1)).toEqual([ACCOUNT_CODE_ANSWERS.used]);
    });
  }

  it("voids every code in one message said in a shared chat", async () => {
    const { ctx, identity, deliver, heard, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const bo = await identity.createPerson({ accounts: [] });
    const { code: annCode } = await accountCodeIssued(ctx, ann.id);
    const { code: boCode } = await accountCodeIssued(ctx, bo.id);

    await deliver(group(`${annCode} and ${boCode.toLowerCase()}`, "m1"));
    expect(heard).toHaveLength(1);

    await deliver(message(annCode, { messageId: "m2" }));
    await deliver(message(boCode, { messageId: "m3", senderId: "T1:U8" }));
    expect(await answers(2)).toEqual([ACCOUNT_CODE_ANSWERS.used, ACCOUNT_CODE_ANSWERS.used]);
  });

  it("admits a code in a direct message whose connection was removed before the answer", async () => {
    const { ctx, identity, deliver, heard, sent } = setup(undefined, false);
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await expect(deliver(message(code))).resolves.toBeUndefined();

    expect((await identity.personOf(ANN_SLACK))?.id).toBe(ann.id);
    expect(heard).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("what a subscriber and a history reader are handed on an own account", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  /**
   * A Slack app's direct message with Ann, through the channel's ports as
   * Rome builds them: live delivery runs admission and hands subscribers what
   * is left, and the platform keeps every message, read back through the
   * messages port.
   */
  function setup() {
    testDb = createTestDb();
    const codes = accountCodeContext(testDb.db);
    const identity = createIdentity(testDb.db);
    const linkOf = (): AccountLink => "own_account";
    // The platform keeps every message it delivered, newest first.
    const platform: ChannelMessage[] = [];
    const talker = {
      send: async (chatId: ChatId) => ({ messageId: "sent", chatId }),
      history: { read: async () => [...platform].reverse() },
    };
    let hearTalker: ((said: connections.Message) => Promise<void>) | undefined;
    const connection = {
      id: "conn",
      connectionKind: "slack_app",
      withTalker: (call: (talker: object) => unknown) => call(talker),
      hearTalker: (listener: (said: connections.Message) => Promise<void>) => {
        hearTalker = listener;
        return () => {};
      },
    };
    const registry = {
      get: () => connection,
      getDescriptor: () => ({ capabilities: { talker: { reads: true } } }),
      find: () => [connection],
      onUnlocked: (_feature: string, unlocked: (c: typeof connection) => void) =>
        unlocked(connection),
      registeredKinds: () => ["slack_app"],
    };
    const ports = connectionPorts(
      {
        registry,
        admit: accountCodeAdmission({
          codes,
          linkOf,
          registry: registry as unknown as Pick<ConnectionRegistry, "get">,
          platformOf: () => ANN_SLACK.platform,
        }),
        channelOf: () => "slack_app",
        handedOn: withoutAccountCodes({ linkOf }),
      } as unknown as ConnectionPortsDeps,
      "slack_app",
    );
    // What a subscriber, and so Chats, an agent or an app, hears live.
    const heard: ChannelMessage[] = [];
    ports!.inbound!.subscribe(async (event: InboundEvent) => {
      if (event.kind === "message") heard.push(event.message);
    });
    let at = 0;
    const deliver = async (
      text: string,
      { senderId = ANN_SLACK.accountId, quoting }: { senderId?: string; quoting?: string } = {},
    ) => {
      at += 1;
      const said = message(text, {
        messageId: `m${at}`,
        senderId,
        timestamp: new Date(at * 1000),
        ...(quoting === undefined ? {} : { replyTo: { messageId: "m1", content: quoting } }),
      });
      platform.push(said);
      await hearTalker!(legacyMessage(said));
    };
    // The port an app's `ChannelsService.query` reads, and a new session's
    // read of the chat's latest messages through it (index.ts).
    const history = ports!.messages!;
    const facts = chatPromptFacts({
      facts: { unseen: () => [], seen: () => undefined },
      messages: { byIds: () => [] },
      labels: {
        read: async (lines) =>
          lines.map(({ senderName, account: _account, ...line }) => ({
            ...line,
            sender: senderName,
            who: "labelled",
            quoted: null,
          })) as never,
        readUnseen: async () => [],
      },
      channelOfChat: () => null,
      channelSurface: () => ({ interactiveCards: false, promptContext: true }),
      latest: (place, read) => history.query({ chatId: place.threadId as ChatId, ...read }),
    });
    return { codes, identity, deliver, heard, history, facts };
  }

  it("leaves out a code refused because the account was taken, which is still usable", async () => {
    const { codes, identity, deliver, history, facts } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    await identity.createPerson({ accounts: [ANN_SLACK] });
    const { code } = await accountCodeIssued(codes, ann.id);

    await deliver(code);
    await deliver("lunch at noon?");

    const read = await history.query({ chatId: "D1" as ChatId });
    expect(read.map((m) => m.text)).toEqual(["lunch at noon?"]);
    const earlier = await facts.earlier?.(
      { channel: "slack_app", threadId: "D1", threadType: "private" },
      new Date(60_000),
    );
    expect(earlier?.map((m) => m.text)).toEqual(["lunch at noon?"]);

    // The code was neither redeemed nor voided by the reads.
    await deliver(code, { senderId: "T1:U8" });
    expect((await identity.personOf({ platform: "slack", accountId: "T1:U8" }))?.id).toBe(ann.id);
  });

  it("keeps a code inside a longer text in the read", async () => {
    const { deliver, history } = setup();

    await deliver("my code is ROME-222222-222222");

    const read = await history.query({ chatId: "D1" as ChatId });
    expect(read.map((m) => m.text)).toEqual(["my code is ROME-222222-222222"]);
  });

  it("hands on a code and a quote of one untouched where Rome has no own account", () => {
    const code = message("ROME-222222-222222");
    const quote = message("did that work?", {
      replyTo: { messageId: "m0", content: "ROME-222222-222222" },
    });
    for (const link of ["delegate", null] as const) {
      const handedOn = withoutAccountCodes({ linkOf: () => link });
      expect(handedOn("telegram_user", code)).toBe(code);
      expect(handedOn("telegram_user", quote)).toBe(quote);
    }
    expect(withoutAccountCodes({ linkOf: () => "own_account" })("slack_app", code)).toBeNull();
  });

  it("hands on a reply that quotes a code without the quote, live and in a read", async () => {
    const { deliver, heard, history } = setup();

    await deliver("ROME-222222-222222");
    await deliver("did that work?", { quoting: "rome-222222-222222 " });

    expect(heard.map((m) => [m.text, m.replyTo])).toEqual([
      ["did that work?", { messageId: "m1" }],
    ]);
    const read = await history.query({ chatId: "D1" as ChatId });
    expect(read.map((m) => [m.text, m.replyTo])).toEqual([["did that work?", { messageId: "m1" }]]);
  });

  it("hands on an ordinary quote untouched", async () => {
    const { deliver, heard, history } = setup();

    await deliver("lunch at noon?");
    await deliver("yes", { quoting: "lunch at noon?" });

    const quote = { messageId: "m1", content: "lunch at noon?" };
    expect(heard.at(-1)?.replyTo).toEqual(quote);
    const read = await history.query({ chatId: "D1" as ChatId });
    expect(read[0].replyTo).toEqual(quote);
  });
});
