import { fileURLToPath } from "node:url";

// The launcher's control server (packages/core/src/test/browser-e2e/server.ts),
// which drives the fake model and the fake WeChat behind the real Rome.

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 4611}`;

export const GUARDIAN = { userId: "e2e-guardian", password: "e2e-password-123" };
export const STORAGE_STATE = fileURLToPath(new URL(".auth/guardian.json", import.meta.url));
/** The guardian's own WeChat user; the fake QR login binds it. */
export const WECHAT_GUARDIAN = "e2e-guardian@im.wechat";

export interface WechatMessage {
  id: string;
  from: string;
  to: string;
  text: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, init);
  if (!res.ok) throw new Error(`Control ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export const control = {
  model: () => call<{ baseUrl: string; calls: Array<{ directive: string | null }> }>("/model"),
  /** A WeChat user writes to Rome's bot. */
  wechatSays: (text: string, from?: string) =>
    call<WechatMessage>("/wechat/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, from }),
    }),
  wechatMessages: () => call<WechatMessage[]>("/wechat/messages"),
  unhandled: () => call<{ model: string[]; wechat: string[]; telegram: string[] }>("/unhandled"),
  /** A person writes in a Telegram chat that the named fake bots are in. */
  telegramSays: (input: TelegramEmit) =>
    call<Record<string, number>>("/telegram/emit", post(input)),
  telegramMessages: () => call<TelegramMessage[]>("/telegram/messages"),
  /** Rows of a read-only query on Rome's database. */
  sql: <T = Record<string, unknown>>(sql: string) => call<T[]>("/sql", post({ sql })),
  saveFixture: (dir: string, manifest: unknown) =>
    call<{ saved: string }>("/fixture/save", post({ dir, manifest })),
};

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** The fake Telegram's bots (packages/core/src/test/browser-e2e/fake-telegram.ts). */
export const TELEGRAM_BOTS = {
  alpha: { username: "e2e_alpha_bot", token: "7000000001:e2e-alpha-token", id: "7000000001" },
  beta: { username: "e2e_beta_bot", token: "7000000002:e2e-beta-token", id: "7000000002" },
} as const;

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup";
  title?: string;
}

export interface TelegramPerson {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramEmit {
  chat: TelegramChat;
  from: TelegramPerson;
  text: string;
  /** The bots in the chat, by username; each receives the message. */
  bots: string[];
  /** A bot the text names with its @handle. */
  mention?: string;
  /** A message to reply to, by the id `bot` knows it by. */
  replyTo?: { bot: string; messageId: number };
}

export interface TelegramMessage {
  bot: string;
  chatId: number;
  messageId: number;
  from: string;
  text: string;
  replyTo?: number;
}

/** A short id that names one test's chats and replies. */
export function token(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
