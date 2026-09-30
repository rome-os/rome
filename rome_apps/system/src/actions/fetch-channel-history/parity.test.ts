// fetch_channel_history reads the same on this path as it did when each
// Connection answered history itself. `parity.main.json` is the tool's output
// on main, before the channel read replaced those Connection reads, over this
// file's seeded mirrors, WeChat reader and Telegram account at a fixed clock:
// main's WhatsApp, LinkedIn and WeChat history features and a Telegram history
// over the same fake account. This test runs the same scenarios through the
// channels and `talk.history.query` and asks for the same output.

import { expect, it, rs } from "@rstest/core";
import { readFileSync } from "node:fs";
import { createTestDb } from "../../../../../packages/core/src/test/helpers.js";
import { readTalkHistory } from "../../../../../packages/core/src/actions/talk-history.js";
import type { Channel } from "../../../../../packages/core/src/channels/channel.js";
import { linkedInMessages } from "../../../../../packages/core/src/channels/linkedin-messages.js";
import { whatsAppMessages } from "../../../../../packages/core/src/channels/whatsapp-messages.js";
import { wechatUserMessages } from "../../../../../packages/core/src/channels/wechat-user-messages.js";
import { WechatUserReader } from "../../../../../packages/core/src/channels/wechat-user.js";
import { historyFeature } from "../../../../../packages/core/src/connections/integrations/talk-features.js";
import type { ConversationId, NormalizedMessage } from "@rome-os/app-runtime";
import {
  linkedinMessages,
  linkedinThreads,
  waChats,
  waContacts,
  waMessages,
} from "../../../../../packages/core/src/db/schema.js";
import type { DrizzleDb } from "../../../../../packages/core/src/db/index.js";
import { createAction } from "./index.js";

const NOW = new Date("2026-09-30T12:00:00.500Z");
const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000);
const H = 3600;

function seedMirrors(db: DrizzleDb): void {
  const now = new Date(0);
  db.insert(waContacts)
    .values([
      {
        jid: "111@s.whatsapp.net",
        name: "Ada",
        phoneNumber: "+111",
        firstSyncedAt: now,
        updatedAt: now,
      },
      { jid: "333@s.whatsapp.net", notify: "Notified", firstSyncedAt: now, updatedAt: now },
      { jid: "444@s.whatsapp.net", phoneNumber: "+444", firstSyncedAt: now, updatedAt: now },
    ])
    .run();
  db.insert(waChats)
    .values({ jid: "g1@g.us", name: "Book club", isGroup: true, updatedAt: now })
    .run();
  const m = (id: string, chat: string, ago: number, o: Record<string, unknown> = {}) => ({
    id,
    chatJid: chat,
    senderJid: chat,
    fromMe: false,
    timestamp: at(ago),
    type: "text",
    text: `line ${id}`,
    hasMedia: false,
    createdAt: now,
    ...o,
  });
  const rows = [
    m("a1", "111@s.whatsapp.net", 10 * H),
    m("a2", "111@s.whatsapp.net", 9 * H, { fromMe: true, senderJid: null, pushName: "Guardian" }),
    m("b1", "222@s.whatsapp.net", 8 * H),
    m("b2", "222@s.whatsapp.net", 7 * H, { pushName: "Pushed" }),
    m("c1", "444@s.whatsapp.net", 6 * H),
    m("g1", "g1@g.us", 5 * H, { senderJid: "333@s.whatsapp.net" }),
    m("g2", "g1@g.us", 4 * H, { senderJid: null }),
    m("g3", "g1@g.us", 3 * H, { fromMe: true, senderJid: "999@s.whatsapp.net" }),
    m("g4", "g1@g.us", 2.5 * H, { senderJid: "555@s.whatsapp.net" }),
    m("r1", "111@s.whatsapp.net", 2 * H, { type: "reaction", text: "👍", reactsToId: "a1" }),
    m("i1", "111@s.whatsapp.net", 1.8 * H, { type: "image", hasMedia: true, text: "a caption" }),
    m("v1", "111@s.whatsapp.net", 1.7 * H, { type: "video", hasMedia: true, text: null }),
    m("old", "111@s.whatsapp.net", 30 * H),
    m("band", "111@s.whatsapp.net", 1.75 * H),
    m("edge", "111@s.whatsapp.net", 24 * H),
    ...Array.from({ length: 120 }, (_, i) =>
      m(`bulk${i}`, "g1@g.us", 20 * H - i * 60, { senderJid: "555@s.whatsapp.net" }),
    ),
  ];
  db.insert(waMessages)
    .values(rows as never)
    .run();

  db.insert(linkedinThreads)
    .values([
      {
        threadId: "t1",
        threadUrl: "u1",
        conversationName: "Recruiting",
        isGroup: true,
        unread: false,
        firstSyncedAt: now,
        updatedAt: now,
      },
      {
        threadId: "t2",
        threadUrl: "u2",
        personName: "Grace",
        unread: false,
        firstSyncedAt: now,
        updatedAt: now,
      },
    ])
    .run();
  const l = (id: string, th: string, ago: number | null, o: Record<string, unknown> = {}) => ({
    messageId: id,
    threadId: th,
    sentAt: ago === null ? null : at(ago),
    senderIsSelf: false,
    text: `li ${id}`,
    createdAt: at(ago ?? 3 * H),
    ...o,
  });
  db.insert(linkedinMessages)
    .values([
      l("m1", "t1", 5 * H, {
        senderName: "Nia",
        senderProfileUrl: "https://www.linkedin.com/in/ACoAANIA/",
      }),
      l("m2", "t1", 4 * H, { senderIsSelf: true, senderName: "Guardian", senderProfileUrl: null }),
      l("m3", "t2", null, { subject: "Hello", text: "body" }),
      l("m4", "t2", 2 * H, { senderProfileUrl: "https://www.linkedin.com/in/vanity/" }),
      l("m5", "t2", 40 * H),
      ...Array.from({ length: 110 }, (_, i) =>
        l(`lb${i}`, "t1", 20 * H - i * 60, { senderName: "Bulk" }),
      ),
    ] as never)
    .run();
}

/** A WeChat client runtime answering `messages` the way the helper does. */
function fakeWechatRuntime(): unknown {
  const rows = [
    {
      id: "w:1",
      conversationId: "wxid_a",
      conversationName: "Alice",
      isGroup: false,
      senderId: "wxid_a",
      senderName: "Alice",
      isSelf: false,
      timestamp: Math.floor(at(5 * H).getTime() / 1000),
      type: "text",
      text: "hi",
    },
    {
      id: "w:2",
      conversationId: "wxid_a",
      isGroup: false,
      senderId: "",
      isSelf: false,
      timestamp: Math.floor(at(4 * H).getTime() / 1000),
      type: "link",
      text: "[link]",
    },
    {
      id: "w:3",
      conversationId: "wxid_a",
      isGroup: false,
      senderId: "wxid_guardian",
      isSelf: true,
      timestamp: Math.floor(at(3 * H).getTime() / 1000),
      type: "text",
      text: "yo",
    },
    {
      id: "w:edge",
      conversationId: "wxid_a",
      isGroup: false,
      senderId: "wxid_a",
      isSelf: false,
      timestamp: Math.floor(at(24 * H).getTime() / 1000),
      type: "text",
      text: "edge",
    },
    ...Array.from({ length: 120 }, (_, i) => ({
      id: `room:${i}`,
      conversationId: "room@chatroom",
      conversationName: "Room",
      isGroup: true,
      senderId: "wxid_b",
      senderName: "Bob",
      isSelf: false,
      timestamp: Math.floor(at(20 * H - i * 60).getTime() / 1000),
      type: "text",
      text: `room ${i}`,
    })),
  ];
  return {
    async readerCommand(args: string[]) {
      const opt = (name: string) => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
      };
      const limit = Number(opt("--limit"));
      const conversation = opt("--conversation");
      const since = opt("--since");
      const held = rows
        .filter((r) => !conversation || r.conversationId === conversation)
        .filter((r) => since === undefined || r.timestamp >= Number(since))
        .sort((a, b) => a.timestamp - b.timestamp);
      return { messages: held.slice(-limit) };
    },
  };
}

/** A Telegram user-account adapter answering history the way the real one does. */
function fakeTelegramAdapter() {
  const msgs: NormalizedMessage[] = [
    {
      id: "t1",
      channel: "telegram_user",
      channelUserId: "42",
      displayName: "Me",
      threadId: "100",
      threadName: "Chat",
      threadType: "private",
      timestamp: at(5 * H),
      text: "mine",
      attachments: [],
      rawEvent: null,
    },
    {
      id: "t2",
      channel: "telegram_user",
      channelUserId: "7",
      displayName: "Chat",
      threadId: "100",
      threadName: "Chat",
      threadType: "private",
      timestamp: at(4 * H),
      text: "theirs",
      attachments: [],
      rawEvent: null,
    },
    {
      id: "t3",
      channel: "telegram_user",
      channelUserId: "8",
      displayName: "",
      threadId: "200",
      threadName: "Group",
      threadType: "group",
      timestamp: at(1.8 * H),
      text: "unnamed",
      attachments: [{ type: "image", fileName: "x.png" }],
      rawEvent: null,
    },
    ...Array.from(
      { length: 120 },
      (_, i): NormalizedMessage => ({
        id: `tb${i}`,
        channel: "telegram_user",
        channelUserId: "7",
        displayName: "Chat",
        threadId: "200",
        threadName: "Group",
        threadType: "group",
        timestamp: at(20 * H - i * 60),
        text: `bulk ${i}`,
        attachments: [],
        rawEvent: null,
      }),
    ),
  ];
  return {
    selfId: "42",
    async fetchHistory(threadId: string | null, windowHours: number): Promise<NormalizedMessage[]> {
      const cutoff = Date.now() - windowHours * 3600 * 1000;
      return msgs
        .filter(
          (m) => (threadId === null || m.threadId === threadId) && m.timestamp.getTime() >= cutoff,
        )
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    },
  };
}

const CONNECTIONS = [
  { connectionId: "c-wa", service: "whatsapp" },
  { connectionId: "c-li", service: "linkedin" },
  { connectionId: "c-wx", service: "wechat_user" },
  { connectionId: "c-tg", service: "telegram_user" },
];

const SCENARIOS: Array<Record<string, unknown>> = [
  { channel: "whatsapp" },
  { channel: "whatsapp", includeMessages: true },
  { channel: "whatsapp", threadId: "111@s.whatsapp.net", includeMessages: true },
  { channel: "whatsapp", threadId: "g1@g.us", includeMessages: true },
  { channel: "whatsapp", windowHours: 1.5, includeMessages: true },
  { channel: "whatsapp", threadId: "g1@g.us", windowHours: 6, includeMessages: true },
  { channel: "linkedin", includeMessages: true },
  { channel: "linkedin", threadId: "t2", includeMessages: true },
  { channel: "linkedin", windowHours: 1.5, includeMessages: true },
  { channel: "wechat_user", includeMessages: true },
  { channel: "wechat_user", threadId: "wxid_a", includeMessages: true },
  { channel: "wechat_user", windowHours: 1.5 },
  { channel: "telegram_user", includeMessages: true },
  { channel: "telegram_user", threadId: "100", includeMessages: true },
  { channel: "telegram_user", windowHours: 1.5, includeMessages: true },
];

async function runScenarios(
  history: (connectionId: string) => {
    query(input: {
      conversationId?: ConversationId;
      since?: Date;
      limit?: number;
    }): Promise<unknown[]>;
  } | null,
): Promise<unknown[]> {
  const talkRouter = {
    list: async () => CONNECTIONS,
    feature: (connectionId: string, name: string) =>
      name === "history" ? history(connectionId) : null,
  };
  const action = createAction({ name: "fetch_channel_history" } as never, { talkRouter } as never);
  const out = [];
  for (const args of SCENARIOS)
    out.push({ args, result: await action.execute(args as never, {} as never) });
  return out;
}

it("reads every channel's history exactly as main did", async () => {
  rs.useFakeTimers({ toFake: ["Date"] });
  rs.setSystemTime(NOW);
  try {
    const { db } = createTestDb();
    seedMirrors(db);
    const telegram = fakeTelegramAdapter();
    const channels: Channel[] = [
      {
        name: "whatsapp",
        send: null,
        inbound: null,
        accounts: null,
        messages: whatsAppMessages(db),
      },
      {
        name: "linkedin",
        send: null,
        inbound: null,
        accounts: null,
        messages: linkedInMessages(db),
      },
      {
        name: "wechat_user",
        send: null,
        inbound: null,
        accounts: null,
        messages: wechatUserMessages(new WechatUserReader(fakeWechatRuntime() as never)),
      },
      {
        name: "telegram_user",
        send: null,
        inbound: null,
        accounts: null,
        messages: null,
      },
    ];
    const telegramHistory = historyFeature(telegram, {
      channel: "telegram_user",
      isOwn: (message) => message.channelUserId === telegram.selfId,
    });
    const serviceOf = new Map(CONNECTIONS.map((c) => [c.connectionId, c.service]));
    const out = await runScenarios((connectionId) => ({
      query: (input) =>
        readTalkHistory(
          {
            channel: channels.find((channel) => channel.name === serviceOf.get(connectionId)),
            connectionHistory: connectionId === "c-tg" ? telegramHistory : null,
          },
          connectionId,
          input,
        ),
    }));
    const main = JSON.parse(readFileSync(new URL("./parity.main.json", import.meta.url), "utf8"));
    expect(JSON.parse(JSON.stringify(out))).toEqual(main);
  } finally {
    rs.useRealTimers();
  }
});
