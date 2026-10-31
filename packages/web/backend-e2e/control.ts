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
  unhandled: () => call<{ model: string[]; wechat: string[] }>("/unhandled"),
};

/** A short id that names one test's chats and replies. */
export function token(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
