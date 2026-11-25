import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { AccountLink } from "@rome/api-types/account-agents";
import type { ConnectionRegistry } from "../../connections/registry.js";
import {
  ACCOUNT_CODE_LIFETIME_MS,
  type AccountCodeContext,
  accountCodeContext,
  AccountCodeUsedError,
  accountCodeIssued,
  accountCodeRedeemed,
} from "../../identity/application/account-codes.js";
import { createIdentity } from "../../identity/identity.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import {
  ACCOUNT_CODE_ANSWERS,
  accountCodeAdmission,
  accountCodeReadBack,
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

  it("refuses an account another person holds, adds nothing, and the code then fails from another account", async () => {
    const { ctx, identity, deliver, heard, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const bo = await identity.createPerson({ accounts: [ANN_SLACK] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await deliver(message(code));
    expect((await identity.personOf(ANN_SLACK))?.id).toBe(bo.id);
    expect(await identity.accountsOf(ann.id)).toEqual([]);

    await deliver(message(code, { messageId: "m2", senderId: "T1:U8" }));
    expect(await identity.personOf({ platform: "slack", accountId: "T1:U8" })).toBeNull();
    expect(await answers(2)).toEqual([ACCOUNT_CODE_ANSWERS.taken, ACCOUNT_CODE_ANSWERS.used]);
    expect(heard).toEqual([]);
  });

  it("finds a code quoted only in a Telegram reply's raw payload already dead", async () => {
    // The point: a reply can carry a quote of a code where no filter sees it,
    // here only in the Bot API's `reply_to_message`. That is harmless, since
    // the code was used up when Rome first heard it, refused or not.
    const { ctx, identity, deliver, heard, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    await identity.createPerson({ accounts: [ANN_SLACK] });
    const { code } = await accountCodeIssued(ctx, ann.id);
    await deliver(message(code, { messageId: "41" }));

    const reply = message("did that work?", {
      messageId: "42",
      replyTo: { messageId: "41" },
      raw: {
        message_id: 42,
        date: 1764064800,
        chat: { id: 7001, type: "private", first_name: "Ann" },
        from: { id: 7001, is_bot: false, first_name: "Ann" },
        text: "did that work?",
        reply_to_message: {
          message_id: 41,
          date: 1764064790,
          chat: { id: 7001, type: "private", first_name: "Ann" },
          from: { id: 7001, is_bot: false, first_name: "Ann" },
          text: code,
        },
      },
    });
    await deliver(reply);
    expect(heard).toEqual([reply]);

    await deliver(message(code, { messageId: "43", senderId: "T1:U8" }));
    expect(await identity.personOf({ platform: "slack", accountId: "T1:U8" })).toBeNull();
    expect(await answers(2)).toEqual([ACCOUNT_CODE_ANSWERS.taken, ACCOUNT_CODE_ANSWERS.used]);
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
    it(`hears a code as an ordinary message and voids it on a connection where Rome has no own account (${link ?? "no agent"})`, async () => {
      const { ctx, identity, deliver, heard, sent, answers, speakAs } = setup();
      speakAs(link);
      const ann = await identity.createPerson({ accounts: [] });
      const bo = await identity.createPerson({ accounts: [] });
      const { code: annCode } = await accountCodeIssued(ctx, ann.id);
      const { code: boCode } = await accountCodeIssued(ctx, bo.id);
      const direct = message(annCode);
      const shared = message(boCode, {
        messageId: "m2",
        chatId: "C1" as ChatId,
        thread: { kind: "group" },
      });

      await deliver(direct);
      await deliver(shared);

      expect(heard).toEqual([direct, shared]);
      expect(await identity.personOf(ANN_SLACK)).toBeNull();
      expect(sent).toEqual([]);
      speakAs("own_account");
      await deliver(message(annCode, { messageId: "m3" }));
      await deliver(message(boCode, { messageId: "m4", senderId: "T1:U8" }));
      expect(await answers(2)).toEqual([ACCOUNT_CODE_ANSWERS.used, ACCOUNT_CODE_ANSWERS.used]);
      expect(await identity.personOf(ANN_SLACK)).toBeNull();
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

  for (const [said, text] of [
    ["the code and a full stop", (code: string) => `${code}.`],
    ["the code after other words", (code: string) => `here: ${code}`],
    ["a Telegram start command with the code", (code: string) => `/start ${code}`],
  ] as const) {
    it(`hears ${said} in a direct message as an ordinary message, and voids the code`, async () => {
      const { ctx, identity, deliver, heard, answers } = setup();
      const ann = await identity.createPerson({ accounts: [] });
      const { code } = await accountCodeIssued(ctx, ann.id);

      await deliver(message(text(code)));
      expect(heard.map((m) => m.text)).toEqual([text(code)]);
      expect(await identity.personOf(ANN_SLACK)).toBeNull();

      await deliver(message(code, { messageId: "m2" }));
      expect(await identity.personOf(ANN_SLACK)).toBeNull();
      expect(await answers(1)).toEqual([ACCOUNT_CODE_ANSWERS.used]);
    });
  }

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

describe("a history read from the platform", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  /**
   * A Slack app's chats, through the channel's ports as Rome builds them. The
   * platform keeps every message said, whether or not it reached Rome live,
   * and answers a history read with what it holds now, edits included.
   */
  function setup(untouchable = false) {
    testDb = createTestDb();
    const real = accountCodeContext(testDb.db);
    const codes = untouchable
      ? new Proxy({} as AccountCodeContext, {
          get() {
            throw new Error("read the codes");
          },
        })
      : real;
    const identity = createIdentity(testDb.db);
    const platform: ChannelMessage[] = [];
    const talker = {
      send: async (chatId: ChatId) => ({ messageId: "sent", chatId }),
      history: { read: async () => [...platform].reverse() },
    };
    const connection = {
      id: "conn",
      connectionKind: "slack_app",
      withTalker: (call: (talker: object) => unknown) => call(talker),
      hearTalker: () => () => {},
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
        channelOf: () => "slack_app",
        readBack: accountCodeReadBack({ codes }),
      } as unknown as ConnectionPortsDeps,
      "slack_app",
    );
    // The port an app's `ChannelsService.query` and an agent's read of the
    // chat's earlier messages both go through.
    const history = ports!.messages!;
    const read = () => history.query({ chatId: "C1" as ChatId });
    // A code tried afterwards from a direct message, which a dead code fails.
    const dead = (code: string) =>
      expect(
        accountCodeRedeemed(real, code, { platform: "slack", accountId: "T1:U9" }),
      ).rejects.toBeInstanceOf(AccountCodeUsedError);
    return { codes: real, identity, platform, read, dead };
  }

  const said = (text: string, at: number): ChannelMessage =>
    message(text, {
      messageId: `m${at}`,
      chatId: "C1" as ChatId,
      thread: { kind: "group" },
      timestamp: new Date(at * 1000),
    });

  it("voids a code pasted in a shared chat that Rome never heard live, and hands the page on whole", async () => {
    const { codes, identity, platform, read, dead } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(codes, ann.id);
    platform.push(said("lunch at noon?", 1), said(code, 2), said(`mine is ${code}`, 3));

    const page = await read();

    expect(page.map((m) => m.text)).toEqual([`mine is ${code}`, code, "lunch at noon?"]);
    await dead(code);
  });

  it("voids a code a message was edited into after Rome heard it", async () => {
    const { codes, identity, platform, read, dead } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(codes, ann.id);
    platform.push(said("hi", 1), said("lunch at noon?", 2));
    platform[0] = { ...platform[0], text: code };

    const page = await read();

    expect(page).toHaveLength(2);
    expect(page[1].text).toBe(code);
    await dead(code);
  });

  it("makes no database read for a page with no code", async () => {
    const { platform, read } = setup(true);
    platform.push(said("lunch at noon?", 1), said("yes", 2));

    expect((await read()).map((m) => m.text)).toEqual(["yes", "lunch at noon?"]);
  });
});
