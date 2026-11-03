/**
 * in-memory TTL map for OAuth CSRF state. The OAuth round-trip
 * is short and a process restart mid-flow leaves the guardian to retry; the
 * The design explicitly does NOT persist this.
 */

const TTL_MS = 30 * 60 * 1000;

/**
 * Where the connect was initiated, so the OAuth callback knows where to land the
 * authorize tab: Settings › Connections (`dashboard`), or a terminal "you're
 * connected, return to your chat" page when an inline card in the chat
 * transcript started the flow (`webchat`).
 */
export type ConnectOrigin = "dashboard" | "webchat";

interface Entry {
  provider: string;
  origin: ConnectOrigin;
  expiresAt: number;
}

export class CsrfStore {
  private readonly entries = new Map<string, Entry>();

  put(token: string, provider: string, origin: ConnectOrigin, now: number = Date.now()): void {
    this.entries.set(token, { provider, origin, expiresAt: now + TTL_MS });
    this.sweep(now);
  }

  consume(
    token: string,
    now: number = Date.now(),
  ): { provider: string; origin: ConnectOrigin } | null {
    this.sweep(now);
    const entry = this.entries.get(token);
    if (!entry) return null;
    this.entries.delete(token);
    if (entry.expiresAt < now) return null;
    return { provider: entry.provider, origin: entry.origin };
  }

  private sweep(now: number): void {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(token);
    }
  }
}

export function randomToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
