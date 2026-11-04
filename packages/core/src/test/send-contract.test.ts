// One suite every channel adapter's `send` runs through: the contract on the
// SDK's `ChannelSend.send`. An adapter parses what it is given and, when it
// cannot deliver the message as given, refuses it with `ChannelSendRefused`
// before anything reaches the platform. It never drops a part, an attachment
// or a quote and reports the rest as sent, and it never sends part of a
// message and then fails on the rest.
//
// Each harness below builds an adapter over a fake of its platform's edge,
// counts what reached that edge and reads back the text it got.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { ChannelType } from "discord.js";
import type { ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { FakeTelegramApi } from "./kit/fake-telegram.js";
import type { PeopleRepository } from "../db/repositories/people.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { MailProvider, SendMailInput } from "../lib/rome-cloud-mail.js";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { DiscordAdapter } from "../connections/kinds/discord/discord.js";
import { EmailAdapter } from "../connections/kinds/email/email.js";
import { FeishuAdapter } from "../connections/kinds/feishu/feishu.js";
import { SlackAdapter, type SlackWebApi } from "../connections/kinds/slack/slack.js";
import { TelegramAdapter } from "../connections/kinds/telegram/telegram.js";
import { TelegramUserAdapter } from "../connections/kinds/telegram-user/telegram-user.js";
import { WebChatAdapter } from "../chats/dashboard/webchat.js";
import { WechatAdapter } from "../connections/kinds/wechat/wechat.js";
import { WhatsAppAdapter } from "../connections/kinds/whatsapp/whatsapp.js";

/** An adapter under the contract, over a fake of its platform. */
interface Harness {
  send(message: OutgoingMessage): Promise<MessageReceipt>;
  /** How many requests reached the platform. */
  calls(): number;
  /** The text of each request that carried text, in order. */
  texts(): string[];
}

interface Subject {
  readonly channel: string;
  make(): Harness;
  /** The part types the channel shows besides text. */
  readonly shows: readonly string[];
  /** How the channel carries an attachment: as a file it uploads, as a line
   *  of text it shows, or not at all. */
  readonly attachments: "files" | "listed" | "none";
  /** Whether an attachment's source may be a web address. */
  readonly urls?: boolean;
  /** `replyToMessageId`s the channel cannot answer, where it quotes at all. A
   *  channel with no way to quote answers in place. */
  readonly unanswerable?: readonly string[];
}

let dir: string;
let file: string;
let locked: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rome-send-contract-"));
  file = join(dir, "report.pdf");
  await writeFile(file, "%PDF-1.4");
  locked = join(dir, "locked.pdf");
  await writeFile(locked, "%PDF-1.4");
  await chmod(locked, 0o000);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  rs.unstubAllGlobals();
});

const CHAT = "100200300" as ChatId;

function telegram(): Harness {
  const api = new FakeTelegramApi();
  const adapter = new TelegramAdapter({ botToken: "test-token" }, api.createBot);
  return {
    send: (message) => adapter.send(CHAT, message),
    calls: () => api.sent.length,
    texts: () =>
      api.sent.flatMap((call) =>
        call.method === "sendMessage" ? [String((call.payload as { text: string }).text)] : [],
      ),
  };
}

function telegramUser(): Harness {
  const sent: Array<{ message?: string; file?: string }> = [];
  const adapter = new TelegramUserAdapter({
    apiId: 12345,
    apiHash: "hash-secret",
    sessionString: "",
    phoneNumber: "+10000000000",
    userId: "42",
    username: "@me",
    displayName: "Me",
    connectedAt: "2026-01-01T00:00:00.000Z",
  });
  Object.assign(adapter, {
    client: {
      sendMessage: async (_entity: unknown, params: { message?: string; file?: string }) => {
        sent.push(params);
        return { id: sent.length };
      },
    },
  });
  return {
    send: (message) => adapter.send(CHAT, message),
    calls: () => sent.length,
    texts: () => sent.flatMap((params) => (params.file ? [] : [params.message ?? ""])),
  };
}

function slack(): Harness {
  const posted: string[] = [];
  const api = {
    postMessage: async (_token: string, input: { markdown: string }) => {
      posted.push(input.markdown);
      return { ts: `1700000000.00010${posted.length}` };
    },
  } as unknown as SlackWebApi;
  const adapter = new SlackAdapter({
    botToken: "xoxb-1",
    appToken: "xapp-1",
    channel: "slack_bot",
    api,
    createSocket: () => {
      throw new Error("not started");
    },
  });
  return {
    send: (message) => adapter.send("C1" as ChatId, message),
    calls: () => posted.length,
    texts: () => posted,
  };
}

function feishu(): Harness {
  const sent: Array<{ markdown: string }> = [];
  const channel = {
    send: async (_to: string, input: { markdown: string }) => {
      sent.push(input);
      return { messageId: "om_sent" };
    },
  };
  const adapter = new FeishuAdapter(
    { appId: "cli_test", appSecret: "secret" },
    () => channel as unknown as LarkChannel,
  );
  return {
    send: (message) => adapter.send("oc_chat" as ChatId, message),
    calls: () => sent.length,
    texts: () => sent.map((input) => input.markdown),
  };
}

function discord(): Harness {
  const sent: Array<{ content?: string; files?: unknown[] }> = [];
  const channel = {
    id: "discord-dm-1",
    type: ChannelType.DM,
    isTextBased: () => true,
    isThread: () => false,
    send: async (input: { content?: string; files?: unknown[] }) => {
      sent.push(input);
      return { id: `${sent.length}` };
    },
  };
  const adapter = new DiscordAdapter({ botToken: "test-token" });
  Object.assign(adapter, { client: { channels: { fetch: async () => channel } } });
  return {
    send: (message) => adapter.send(channel.id as ChatId, message),
    calls: () => sent.length,
    texts: () => sent.flatMap((input) => (input.files ? [] : [input.content ?? ""])),
  };
}

function whatsapp(): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const adapter = new WhatsAppAdapter({ authStatePath: join(tmpdir(), "rome-wa-contract") });
  Object.assign(adapter, {
    sock: {
      user: { id: "15550000000@s.whatsapp.net" },
      sendMessage: async (_jid: string, content: Record<string, unknown>) => {
        sent.push(content);
        return { key: { id: `wa-${sent.length}` } };
      },
    },
  });
  return {
    send: (message) => adapter.send("15551234567@s.whatsapp.net" as ChatId, message),
    calls: () => sent.length,
    texts: () =>
      sent.flatMap((content) => (typeof content.text === "string" ? [content.text] : [])),
  };
}

function wechat(): Harness {
  const requests: string[] = [];
  rs.stubGlobal(
    "fetch",
    rs.fn(async (url: string, init: { body: string }) => {
      if (url.includes("getuploadurl")) {
        return new Response(JSON.stringify({ upload_full_url: "https://cdn.example/upload" }));
      }
      if (url.startsWith("https://cdn.example/")) {
        return new Response("", { headers: { "x-encrypted-param": "param" } });
      }
      requests.push(init.body);
      return new Response(JSON.stringify({ ret: 0, message_id: requests.length }));
    }),
  );
  const adapter = new WechatAdapter({
    token: "token",
    baseUrl: "https://ilinkai.weixin.qq.com",
    accountId: "account",
    connectedAt: "2026-05-09T00:00:00.000Z",
  });
  (adapter as unknown as { contextTokens: Map<string, string> }).contextTokens.set(
    "wx-user",
    "ctx-1",
  );
  return {
    send: (message) => adapter.send("wx-user" as ChatId, message),
    calls: () => requests.length,
    texts: () =>
      requests.flatMap((body) => {
        const items = (
          JSON.parse(body) as { msg?: { item_list?: Array<{ text_item?: { text: string } }> } }
        ).msg?.item_list;
        return (items ?? []).flatMap((item) => (item.text_item ? [item.text_item.text] : []));
      }),
  };
}

function email(): Harness {
  const sent: SendMailInput[] = [];
  const provider = {
    send: async (input: SendMailInput) => {
      sent.push(input);
      return { messageId: "m_out", threadId: "t_out" };
    },
  } as unknown as MailProvider;
  const adapter = new EmailAdapter({
    provider,
    settingsRepo: {} as unknown as SettingsRepository,
    peopleRepo: {} as unknown as PeopleRepository,
    config: { address: "slug@mail.romeos.cc", inboundSecret: "secret" },
  });
  return {
    send: (message) => adapter.send("ada@example.com" as ChatId, message),
    calls: () => sent.length,
    texts: () => sent.map((input) => input.text ?? ""),
  };
}

function webchat(): Harness {
  const stored: Array<Array<{ type: string; content?: string }>> = [];
  const repo = {
    addSentMessage: async (_id: string, _thread: string, parts: Array<{ type: string }>) => {
      stored.push(parts);
    },
  } as unknown as WebChatRepository;
  const adapter = new WebChatAdapter(repo);
  return {
    send: (message) => adapter.send("session-1" as ChatId, message),
    calls: () => stored.length,
    texts: () =>
      stored.flatMap((parts) =>
        parts.flatMap((part) => (part.type === "text" ? [part.content ?? ""] : [])),
      ),
  };
}

const NUMERIC_UNANSWERABLE = ["", "   ", "abc", "12.5", "1e400"];

const SUBJECTS: readonly Subject[] = [
  {
    channel: "telegram",
    make: telegram,
    shows: [],
    attachments: "files",
    urls: true,
    unanswerable: NUMERIC_UNANSWERABLE,
  },
  {
    channel: "telegram_user",
    make: telegramUser,
    shows: [],
    attachments: "files",
    urls: true,
    unanswerable: NUMERIC_UNANSWERABLE,
  },
  {
    channel: "slack",
    make: slack,
    shows: [],
    attachments: "none",
    unanswerable: ["", "abc", "1700000000", "C1:1700000000.000100"],
  },
  {
    channel: "feishu",
    make: feishu,
    shows: [],
    attachments: "none",
    unanswerable: ["", "abc", "om_ bad", "oc_chat"],
  },
  {
    channel: "discord",
    make: discord,
    shows: [],
    attachments: "files",
    urls: true,
    unanswerable: ["", "abc", "12a", "123456789012345678901"],
  },
  { channel: "whatsapp", make: whatsapp, shows: [], attachments: "files", urls: false },
  { channel: "wechat", make: wechat, shows: [], attachments: "files", urls: false },
  { channel: "email", make: email, shows: [], attachments: "none" },
  {
    channel: "webchat",
    make: webchat,
    shows: ["approval_card", "interaction_result"],
    attachments: "listed",
  },
];

const refused = (reason: string) => ({ name: "ChannelSendRefused", reason });

const CARD = {
  type: "approval_card",
  approvalId: "a-1",
  actionName: "send_email",
  preview: { kind: "generic", title: "Send an email", summary: "To Dana, about Friday" },
  status: "pending",
} as NonNullable<OutgoingMessage["parts"]>[number];

describe.each(SUBJECTS)("$channel send", (subject) => {
  it("refuses a message that says nothing, and sends nothing", async () => {
    const harness = subject.make();
    for (const message of [
      {},
      { text: "" },
      { text: "   " },
      { parts: [{ type: "text" as const, content: "  " }] },
      { text: " ", parts: [{ type: "text" as const, content: "" }] },
    ]) {
      await expect(harness.send(message)).rejects.toMatchObject(refused("empty"));
    }
    expect(harness.calls()).toBe(0);
  });

  it("sends `text` over the text parts, and the text parts when `text` is blank", async () => {
    const harness = subject.make();
    await harness.send({ text: "Said", parts: [{ type: "text", content: "Ignored" }] });
    await harness.send({ text: "  ", parts: [{ type: "text", content: "From parts" }] });
    const texts = harness.texts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Said");
    expect(texts[0]).not.toContain("Ignored");
    expect(texts[1]).toContain("From parts");
  });

  it("refuses a part it does not show rather than drop it", async () => {
    const harness = subject.make();
    const forged = { type: "routine_draft_card" } as unknown as typeof CARD;
    const bare = { ...CARD, preview: undefined } as unknown as typeof CARD;
    const unshown = subject.shows.includes(CARD.type) ? [forged] : [bare, forged];
    for (const part of unshown) {
      await expect(
        harness.send({ text: "Look", parts: [{ type: "text", content: "Look" }, part] }),
      ).rejects.toMatchObject(refused("part_unsupported"));
    }
    expect(harness.calls()).toBe(0);
  });

  if (!subject.shows.includes(CARD.type)) {
    it("sends an approval card it cannot draw as the card's plain-text version", async () => {
      const harness = subject.make();
      await harness.send({ parts: [CARD] });
      const [said] = harness.texts();
      expect(said).toContain("Approval needed: Send an email");
      expect(said).toContain("To Dana, about Friday");
      expect(said).toContain("The guardian approves or denies it on Rome");
    });

    it("sends `text` and then the card's plain-text version, never the text alone", async () => {
      const harness = subject.make();
      await harness.send({
        text: "Before I send it:",
        parts: [{ type: "text", content: "x" }, CARD],
      });
      const [said] = harness.texts();
      expect(said).toContain("Before I send it:");
      expect(said).toContain("Approval needed: Send an email");
      expect(said).not.toContain("x\n");
    });
  }

  if (subject.attachments === "none") {
    it("refuses any attachment, and sends nothing", async () => {
      const harness = subject.make();
      await expect(
        harness.send({ text: "Here", attachments: [{ type: "document", source: file }] }),
      ).rejects.toMatchObject(refused("attachment_unsupported"));
      expect(harness.calls()).toBe(0);
    });
  }

  if (subject.attachments === "files") {
    it("sends a file with no text", async () => {
      const harness = subject.make();
      await harness.send({ attachments: [{ type: "document", source: file }] });
      expect(harness.calls()).toBe(1);
      expect(harness.texts()).toEqual([]);
    });

    it("refuses an attachment it cannot send before the text goes out", async () => {
      const harness = subject.make();
      const unsendable = [
        { type: "sticker", source: file },
        { type: "document", source: "" },
        { type: "document", source: "   " },
        { type: "document" },
        { type: "document", source: file, caption: 42 },
        { type: "document", source: join(dir, "missing.pdf") },
        // Root reads a file whatever its mode, so only another user sees it locked.
        ...(process.getuid?.() === 0 ? [] : [{ type: "document", source: locked }]),
        { type: "document", source: dir },
        ...(subject.urls ? [] : [{ type: "image", source: "https://example.com/a.png" }]),
      ] as unknown as NonNullable<OutgoingMessage["attachments"]>;
      for (const attachment of unsendable) {
        await expect(
          harness.send({
            text: "Here it is",
            attachments: [{ type: "document", source: file }, attachment],
          }),
        ).rejects.toMatchObject(refused("attachment_unsupported"));
      }
      expect(harness.calls()).toBe(0);
    });
  }

  if (subject.unanswerable) {
    it("refuses a reply to an id that is none of its messages, and sends nothing", async () => {
      const harness = subject.make();
      for (const replyToMessageId of subject.unanswerable ?? []) {
        await expect(harness.send({ text: "Re", replyToMessageId })).rejects.toMatchObject(
          refused("reply_unaddressable"),
        );
      }
      expect(harness.calls()).toBe(0);
    });
  }
});
