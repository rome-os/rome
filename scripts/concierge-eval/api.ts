// The owner's side of the dashboard API, as the eval plays it: the same
// routes the web and iOS apps call. docs/concierge-eval.md

import { createHmac, randomUUID } from "node:crypto";

/** The dev stack's default JWT secret (packages/core/src/access/auth.ts). */
export const DEV_JWT_SECRET = "rome-dev-secret-change-me";

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** A `rome_session` cookie for `userId`, signed as the backend signs one. */
export function sessionCookie(userId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ userId, iat: now, exp: now + 7 * 24 * 3600 }));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `rome_session=${head}.${body}.${sig}`;
}

export interface Part {
  type: string;
  [field: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  sender?: { kind?: string };
  chatThreadId?: string | null;
}

export interface TaskCard {
  kind: "question" | "approval" | "unavailable";
  id?: string;
  messageId?: string;
  render?: { props?: { questions?: Question[] } };
  expired?: boolean;
  outcome?: unknown;
}

export interface Question {
  question: string;
  type: "single" | "multi" | "text";
  options?: string[];
}

export interface TaskDto {
  id: string;
  title: string;
  status: "needs_you" | "active" | "later" | "ended";
  endReason: "done" | "failed" | "stopped" | "no_response" | null;
  chat?: { id: string } | null;
}

class TransientError extends Error {}

export class Api {
  private readonly cookie: string;

  constructor(
    readonly baseUrl: string,
    userId: string,
    secret: string,
  ) {
    this.cookie = sessionCookie(userId, secret);
  }

  /**
   * A read, or a call safe to repeat, retries a gateway error, a locked
   * database or a dropped connection a few times: the dev stack answers so
   * now and then while it is busy.
   */
  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotent = false,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, body);
      } catch (error) {
        const transient = error instanceof TransientError || error instanceof TypeError;
        if (!(method === "GET" || idempotent) || !transient || attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  private async once<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        // Approvals take a mutation only from the dashboard's own origin.
        "sec-fetch-site": "same-origin",
        origin: this.baseUrl,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const message = `${method} ${path}: ${res.status} ${text.slice(0, 300)}`;
      const locked = res.status === 500 && text.includes("database is locked");
      throw res.status >= 502 || locked ? new TransientError(message) : new Error(message);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Who the cookie signs in as: the guardian, or the call fails. */
  async checkGuardian(): Promise<void> {
    await this.call("GET", "/api/concierge/session");
  }

  createTopicChat(name: string): Promise<{ id: string; name: string }> {
    return this.call("POST", "/api/concierge/chats", { name });
  }

  /** Sends the owner's message and answers its id. */
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string> {
    const inputId = randomUUID();
    // A send with the same input id answers the turn it already started, so
    // it is safe to send again.
    await this.call(
      "POST",
      `/api/chat/sessions/${encodeURIComponent(chatId)}/turns`,
      { text, inputId, ...(replyToMessageId ? { replyToMessageId } : {}) },
      true,
    );
    return inputId;
  }

  messages(chatId: string): Promise<ChatMessage[]> {
    return this.call("GET", `/api/chat/sessions/${encodeURIComponent(chatId)}/messages`);
  }

  /** Turns running or queued in a chat; empty when it is quiet. */
  turns(chatId: string): Promise<unknown[]> {
    return this.call("GET", `/api/chat/sessions/${encodeURIComponent(chatId)}/turns`);
  }

  /** The chat's Tasks panel rows, ended ones included. */
  async tasks(chatId: string): Promise<TaskDto[]> {
    const panel = await this.call<{ groups: { items: { kind: string; task?: TaskDto }[] }[] }>(
      "GET",
      `/api/chats/${encodeURIComponent(chatId)}/tasks`,
    );
    return panel.groups.flatMap((g) => g.items.flatMap((i) => (i.task ? [i.task] : [])));
  }

  /** Answers a question card the way its form sends: one entry per question. */
  answerCard(
    widgetMessageId: string,
    answers: { values: string[]; text: string }[],
  ): Promise<unknown> {
    return this.call("POST", `/api/chat/widgets/${encodeURIComponent(widgetMessageId)}/events`, {
      name: "send",
      context: { answers },
    });
  }

  decideApproval(approvalId: string, decision: "approve" | "reject"): Promise<unknown> {
    return this.call("POST", `/api/approvals/${encodeURIComponent(approvalId)}/${decision}`, {});
  }
}

export function partsOf(message: ChatMessage): Part[] {
  try {
    const parsed = JSON.parse(message.content) as unknown;
    return Array.isArray(parsed) ? (parsed as Part[]) : [];
  } catch {
    return [];
  }
}
