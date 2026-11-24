// A message that reaches the chat during a voice conversation outside the
// guardian's spoken turns, such as a task's result the Concierge says. Rome
// does not read it at once: once the guardian and Rome are both quiet, it asks
// once whether to read it, and reads it whole only on a yes. This file reads
// such a message and the guardian's answer. When to ask is `conversation.ts`'s.

import type { ReplyEvent } from "./conversation.js";
import { partsOf } from "./delivered-reply.js";
import type { ReplyLanguage } from "./speakable.js";

/** A late message, as Rome offers it. */
export interface LateMessage {
  /**
   * What it reports on: the task whose start message it replies to, the task
   * chat its card shows, or else its own turn. A conversation asks once per key.
   */
  key: string;
  turnId: string | null;
  /** The start message it replies to, to look the task's name up by. */
  replyTo: string | null;
  /** The task's name, when the message itself carries it. */
  name: string | null;
  /** Whether it reports on a task. */
  task: boolean;
  /** What reading it says and shows. */
  events: ReplyEvent[];
  /** Its words, to tell its language by. */
  text: string;
}

/** Reads a stored message, or null when it says and shows nothing. */
export function lateMessage(content: string, turnId: string | null): LateMessage | null {
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(parts)) return null;
  let replyTo: string | null = null;
  let taskChat: string | null = null;
  let name: string | null = null;
  for (const part of parts) {
    const p = (part ?? {}) as Record<string, unknown>;
    if (p.type === "reply_to" && typeof p.messageId === "string") replyTo = p.messageId;
    if (p.type === "task_chat" && typeof p.chatId === "string") {
      taskChat = p.chatId;
      if (typeof p.title === "string") name = p.title;
    }
    const from = p.forwardedFrom as { chatId?: unknown; title?: unknown } | undefined;
    if (from && typeof from.title === "string") {
      name ??= from.title;
      if (typeof from.chatId === "string") taskChat ??= from.chatId;
    }
  }
  const events = partsOf(content);
  if (events.length === 0) return null;
  const text = events.map((e) => (e.type === "said" ? e.text : "")).join(" ");
  const key = replyTo
    ? `start:${replyTo}`
    : taskChat
      ? `task:${taskChat}`
      : `turn:${turnId ?? Math.random().toString(36).slice(2)}`;
  return { key, turnId, replyTo, name, task: Boolean(replyTo || taskChat), events, text };
}

// A name read aloud stays short.
const NAME_MAX = 24;

/** What Rome asks before reading a late message. */
export function offerLine(
  message: Pick<LateMessage, "name" | "task">,
  language: ReplyLanguage,
): string {
  const name = message.name?.replace(/[*_`#[\]【】<>]/g, "").trim();
  const short = name && name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name;
  if (language === "zh") {
    if (short) return `「${short}」有结果了，要听吗？`;
    return message.task ? "有个任务有结果了，要听吗？" : "有新消息了，要听吗？";
  }
  if (short) return `${short} has a result. Want to hear it?`;
  return message.task
    ? "A task has a result. Want to hear it?"
    : "There's a new message. Want to hear it?";
}

const ZH_YES_WORD = /^(?:嗯|好|要|念|读|说|听|可以|行|来|吧|的|啊|呀|一下)+$/u;
const ZH_YES_CORE = /[嗯好要念读说听行来]|可以/u;
const EN_YES_FIRST = new Set(["yes", "yeah", "yep", "sure", "ok", "okay", "go", "read", "please"]);
const EN_YES_WORDS = new Set([...EN_YES_FIRST, "ahead", "it", "on", "out"]);

/** Whether the guardian's turn is a short yes to "want to hear it?". */
export function isYes(text: string): boolean {
  const zh = text.replace(/[\s\p{P}]/gu, "");
  if (/\p{Script=Han}/u.test(zh)) {
    return zh.length <= 6 && ZH_YES_WORD.test(zh) && ZH_YES_CORE.test(zh);
  }
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 4 &&
    EN_YES_FIRST.has(words[0] as string) &&
    words.every((w) => EN_YES_WORDS.has(w))
  );
}
