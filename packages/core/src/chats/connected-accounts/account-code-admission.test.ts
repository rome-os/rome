import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../../connections/registry.js";
import {
  ACCOUNT_CODE_LIFETIME_MS,
  type AccountCodeContext,
  accountCodeContext,
  accountCodeIssued,
} from "../../identity/application/account-codes.js";
import { createIdentity } from "../../identity/identity.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { ACCOUNT_CODE_ANSWERS, accountCodeAdmission } from "./account-code-admission.js";
import { OrderedAdmission } from "./admission.js";

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

  function setup(codes?: AccountCodeContext) {
    testDb = createTestDb();
    const clock = { now: new Date("2026-11-25T10:00:00Z") };
    const ctx = codes ?? accountCodeContext(testDb.db, () => clock.now);
    const identity = createIdentity(testDb.db);
    const sent: Array<{ chatId: ChatId; text: string }> = [];
    const send = rs.fn(async (chatId: ChatId, out: { text?: string }) => {
      sent.push({ chatId, text: out.text ?? "" });
      return { messageId: "sent", chatId };
    });
    const registry = {
      get: () => ({ withTalker: (call: (talker: object) => unknown) => call({ send }) }),
    } as unknown as Pick<ConnectionRegistry, "get">;
    const admit = accountCodeAdmission({
      codes: ctx,
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
    return { ctx, identity, deliver, heard, sent, answers, later };
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

  it("voids a code said in a shared chat, adds nothing, and the code then fails in a direct message", async () => {
    const { ctx, identity, deliver, heard, sent, answers } = setup();
    const ann = await identity.createPerson({ accounts: [] });
    const { code } = await accountCodeIssued(ctx, ann.id);

    await deliver(message(code, { chatId: "C1" as ChatId, thread: { kind: "group" } }));
    expect(await identity.personOf(ANN_SLACK)).toBeNull();

    await deliver(message(code, { messageId: "m2" }));
    expect(await identity.personOf(ANN_SLACK)).toBeNull();
    expect(await answers(2)).toEqual([ACCOUNT_CODE_ANSWERS.shared, ACCOUNT_CODE_ANSWERS.used]);
    expect(sent[0].chatId).toBe("C1");
    expect(heard).toEqual([]);
  });

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
});
