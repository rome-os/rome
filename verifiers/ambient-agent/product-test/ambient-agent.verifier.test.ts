// Rule 4(b) of the ambient agent goal, rule set V4: an agent in a shared
// group chat, mentioned by a member who is not the guardian, recalls what
// others said there without mentioning it, and says nothing when nobody
// mentions it. The chat lives on a stand-in connection that does three things
// only: it delivers messages, sends a message to a named chat and thread, and
// answers a read of a chat's messages from its own log. So the agent can know
// the rest only by reading the platform at the mention. Rome is booted by the
// test kit's `bootWorkspaceAccount`, which wires the kind's account with the
// Concierge as index.ts does. The model is scripted, and answers with a value
// only when the text it was shown holds it.

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { ConnectionDescriptor, Talker, TalkHistory } from "./connections/types.js";
import { FakeModel, result } from "./test/kit/fake-model.js";
import { bootWorkspaceAccount } from "./test/kit/workspace-account.js";

const KIND = "standin";
const BOT = "standin-bot";
// A thread's address is `<chat>:<thread id>`, so a chat id holds no colon.
const CHAT = "group-1";
const GUARDIAN = { accountId: "u-grace", name: "Grace" };
// Persons A and B of the rules: members of the workspace who are not the guardian.
const ASKER = { accountId: "u-hal", name: "Hal" };
const MEMBERS = [
  { accountId: "u-ada", name: "Ada" },
  { accountId: "u-linus", name: "Linus" },
  { accountId: "u-mary", name: "Mary" },
];

type Person = { accountId: string; name: string };

/** The platform: every message said in the group, oldest first, each with the
 *  thread it was said in, if any. */
function standInPlatform() {
  const log: (ChannelMessage & { inThread?: string })[] = [];
  let clock = Date.now() - 3_600_000;
  const append = (sender: Person, text: string, inThread?: string) => {
    const message = {
      channel: KIND,
      direction: sender.accountId === BOT ? "outbound" : "inbound",
      messageId: `m${log.length + 1}`,
      chatId: CHAT as ChatId,
      senderId: sender.accountId,
      senderDisplayName: sender.name,
      text,
      attachments: [],
      timestamp: new Date((clock += 1000)),
      thread: { kind: "group", name: "Team" },
      ...(inThread ? { inThread, replyTo: { messageId: inThread } } : {}),
    } as ChannelMessage & { inThread?: string };
    log.push(message);
    return message;
  };
  const history: TalkHistory = {
    async read(address, { since, until, olderThan, newerThan, limit }) {
      const [chat, thread] = String(address).split(":");
      let said = log.filter(
        (m) =>
          m.chatId === chat &&
          (thread === undefined || m.messageId === thread || m.inThread === thread),
      );
      if (olderThan !== undefined)
        said = said.slice(
          0,
          said.findIndex((m) => m.messageId === olderThan),
        );
      if (newerThan !== undefined)
        said = said.slice(said.findIndex((m) => m.messageId === newerThan) + 1).slice(0, limit);
      said = said.filter(
        (m) =>
          (!since || m.timestamp.getTime() >= since.getTime()) &&
          (!until || m.timestamp.getTime() <= until.getTime()),
      );
      return said.slice(-limit).reverse();
    },
  };
  async function send(place: { chat: string; thread?: string }, text: string) {
    const thread = place.thread?.split(":")[1];
    return append({ accountId: BOT, name: "Rome" }, text, thread).messageId;
  }
  const talker: Talker = {
    start() {},
    stop() {},
    async send(chatId, outgoing) {
      const messageId = await send({ chat: chatId }, outgoing.text ?? "");
      return { chatId, messageId };
    },
    history,
  };
  // The fields a kind declares to serve a whole workspace from one session,
  // with the Concierge on an account made for it.
  const descriptor = {
    connectionKind: KIND,
    link: "own_account",
    startsWithConcierge: true,
    servesWorkspace: true,
    grant: "bot",
    auth: {
      obtain: async () => ({ material: {}, expiresAt: "never" }),
      renew: async (cred) => cred,
    },
    accountIdOf: () => BOT,
    capabilities: { talker: { reads: true, build: () => talker } },
  } as ConnectionDescriptor;
  return { descriptor, log, append, ports: { history, send } };
}

const TURN_MS = 30_000;

/**
 * Rome serving the stand-in platform's workspace. This is the one place the
 * test wires Rome: the tests use only `say`, `mention`, `sent` and `close`.
 */
async function bootRome(model: FakeModel) {
  const platform = standInPlatform();
  const account = await bootWorkspaceAccount({
    kind: platform.descriptor,
    ports: platform.ports,
    model,
  });
  await account.rome.repos.people.create({
    displayName: GUARDIAN.name,
    bondLevel: "guardian",
    links: [{ platform: KIND, id: GUARDIAN.accountId }],
  } as never);
  const deliver = async (sender: Person, text: string, mentionsRome: boolean, thread?: string) => {
    const said = platform.append(sender, text, thread);
    const turn = account.deliver({
      id: said.messageId,
      sender: sender.accountId,
      senderName: sender.name,
      chat: CHAT,
      ...(thread ? { thread: `${CHAT}:${thread}` } : {}),
      text,
      mentionsRome,
    });
    const timeout = new Promise<{ woke: boolean }>((resolve) =>
      setTimeout(() => resolve({ woke: true }), TURN_MS),
    );
    return Promise.race([turn, timeout]);
  };
  return {
    log: platform.log,
    /** What Rome sent, oldest first. */
    get sent() {
      return account.sent;
    },
    /** Said in the group without mentioning Rome; the platform keeps it. */
    say: (sender: Person, text: string, thread?: string) => deliver(sender, text, false, thread),
    /** Said in the group mentioning Rome; resolves when the turn ends. */
    mention: (sender: Person, text: string) => deliver(sender, `@Rome ${text}`, true),
    close: () => account.close(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A value no model could guess. */
const fresh = () => `WORD-${randomBytes(3).toString("hex").toUpperCase()}`;

const CHATTER = [
  "morning all",
  "did anyone see the build?",
  "lunch at noon?",
  "I pushed the fix",
  "the meeting moved to 3",
  "thanks!",
  "who has the projector key?",
  "back in ten",
  "the coffee machine is fixed",
  "sounds good",
];

describe("an agent in a shared group chat", () => {
  let model: FakeModel;
  let rome: Awaited<ReturnType<typeof bootRome>>;

  beforeEach(async () => {
    model = new FakeModel().setDefaultReply(result("I don't know."));
    rome = await bootRome(model);
  });

  afterEach(async () => {
    await rome.close();
  });

  /**
   * Ten rounds: a member writes a fact, others write ten more messages, then
   * `asker` mentions Rome and asks for it. A round holds the fact when a send
   * after the mention, to the chat that asked, holds its value.
   */
  async function recallRounds(asker: { accountId: string; name: string }) {
    const values = Array.from({ length: 10 }, fresh);
    // The newest value it was shown is the one it answers with, as a model
    // asked about the latest code would.
    for (const value of [...values].reverse()) {
      model
        .when((p) => p.prompt.includes(value) || p.systemPrompt.includes(value))
        .reply(result(`It is ${value}`));
    }
    let held = 0;
    let answered = 0;
    for (const [round, value] of values.entries()) {
      await rome.say(
        MEMBERS[round % MEMBERS.length],
        `the order number for the office chairs is now ${value}`,
      );
      for (const [i, line] of CHATTER.entries())
        await rome.say(MEMBERS[(round + i + 1) % MEMBERS.length], line);
      const before = rome.sent.length;
      await rome.mention(asker, "what is the order number for the office chairs now?");
      const replies = rome.sent.slice(before).filter((s) => s.chat === CHAT);
      if (replies.length) answered++;
      if (replies.some((s) => s.text.includes(value))) held++;
    }
    return `${held} of 10 facts held (${10 - answered} mention(s) got no reply)`;
  }

  it("recall: 10 of 10 facts held after 10 other messages each", async () => {
    expect(await recallRounds(ASKER)).toBe("10 of 10 facts held (0 mention(s) got no reply)");
  }, 120_000);

  it("recall when the guardian asks: not scored", async () => {
    expect(await recallRounds(GUARDIAN)).toBe("10 of 10 facts held (0 mention(s) got no reply)");
  }, 120_000);

  it("silence: 0 sends across 50 unmentioned messages", async () => {
    let woke = 0;
    const said = async (sending: Promise<{ woke: boolean }>) => {
      if ((await sending).woke) woke++;
    };
    for (let i = 0; i < 50; i++) {
      const sender = MEMBERS[i % MEMBERS.length];
      const earlier = rome.log.at(-1);
      switch (i % 4) {
        case 0:
          await said(rome.say(sender, CHATTER[i % CHATTER.length]));
          break;
        case 1:
          await said(rome.say(sender, `does anyone know where the ${i}th report went?`));
          break;
        case 2:
          await said(rome.say(sender, "agreed", earlier?.messageId));
          break;
        default:
          await said(rome.say(sender, "Rome would know this, I bet"));
      }
    }
    await sleep(500);
    expect({ woke, sent: rome.sent.length }).toEqual({ woke: 0, sent: 0 });
  });
});
