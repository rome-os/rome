// Every message a Concierge turn with a push level says goes to its chat's
// owner's phone, the guardian's or a visitor's, unless their phone shows the
// chat, their dashboard is active, or their quiet hours hold it. Per chat,
// messages within MERGE_MS of the last push merge into one, and a push rings
// only after RING_MS without one
// (docs/adrs/proactive-concierge-push-without-per-message-consent.md).

import { withoutSessionActor } from "../access/session-actor.js";
import { marked, type Token } from "marked";
import type { NotifyLevel, SendOutcome, SystemNotifyContent } from "../instance/notify-client.js";
import { createLogger } from "../logger.js";
import type { ConciergeOwner } from "../webchat/owner.js";
import { recipientOf } from "./owners.js";

const log = createLogger("concierge-push");

/** About this many characters of the message reach the phone. */
export const PUSH_BODY_MAX_CHARS = 100;
/** Messages said in a chat within this long of its last push merge into one push, showing the latest. */
export const MERGE_MS = 15_000;
/** A push rings only when its chat's last push is older than this; otherwise it arrives silently. */
export const RING_MS = 2 * 60_000;
/** Past this many chats, ones idle for RING_MS are forgotten. */
const CHATS_KEPT = 64;

// The lexer escapes these in text, as HTML would show them.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Block tokens end with a space, so two paragraphs never run together.
const BLOCKS = new Set(["paragraph", "heading", "code", "blockquote", "list_item", "table"]);

function plainOf(tokens: Token[]): string {
  return tokens
    .map((token) => {
      const text = (() => {
        switch (token.type) {
          case "list":
            return plainOf(token.items as Token[]);
          case "table":
            return [token.header, ...token.rows]
              .flat()
              .map((cell: { tokens: Token[] }) => plainOf(cell.tokens))
              .join(" ");
          case "image":
            return token.text;
          case "html":
          case "space":
          case "hr":
          case "br":
            return " ";
          case "code":
            // A pictures block is one `![title](address) note` line per picture:
            // its words are each picture's title and note, not its addresses.
            return token.lang?.trim().split(/\s+/, 1)[0] === "pictures"
              ? plainOf(marked.lexer(token.text))
              : token.text;
          case "codespan":
            return token.text;
        }
        if ("tokens" in token && token.tokens?.length) return plainOf(token.tokens);
        return "text" in token && typeof token.text === "string" ? token.text : "";
      })();
      return BLOCKS.has(token.type) ? `${text} ` : text;
    })
    .join("");
}

/**
 * The message as a push shows it: Markdown reduced to its words on one line,
 * cut to about {@link PUSH_BODY_MAX_CHARS} characters, never inside an emoji.
 */
export function pushBody(markdown: string): string {
  const text = plainOf(marked.lexer(markdown))
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(graphemes.segment(text), (part) => part.segment);
  if (chars.length <= PUSH_BODY_MAX_CHARS) return text;
  return `${chars
    .slice(0, PUSH_BODY_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

export interface ConciergePushDeps {
  notify: { send(content: SystemNotifyContent): Promise<SendOutcome> };
  /** Whose a chat is, or null when it no longer exists. */
  ownerOf: (chatId: string) => Promise<ConciergeOwner | null>;
  /** When `owner`'s quiet window `at` falls in ends, or null outside their quiet hours. */
  quietUntil: (at: number, owner: ConciergeOwner) => Promise<number | null>;
  /** The people whose phone app shows this chat now: it is read there, not pushed to them. */
  watchersOf?: (chatId: string) => ReadonlySet<ConciergeOwner>;
  /** The people at one of their web dashboards now: none of their pushes goes out. */
  activeOwners?: () => ReadonlySet<ConciergeOwner>;
  /** `owner`'s dashboard language, or null. */
  language: (owner: ConciergeOwner) => Promise<string | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/** What the Concierge said, and where. */
export interface SaidInTurn {
  turnId: string;
  chatId: string;
  /**
   * The message in the Concierge's own words: what it wrote in this message,
   * never content it forwarded or quoted, nor a task's title or chat name,
   * which may hold a secret it would not repeat. Null when it wrote none, as
   * for a bare forward or a card: the push then says {@link FIXED_LINE}.
   */
  ownWords: string | null;
  /** The Concierge marked the message private: the push says {@link FIXED_LINE}. */
  private?: boolean;
  /** The turn's push level; undefined for a reminder, a recovery or a notice. */
  level: NotifyLevel | undefined;
}

/** The line a push says for a message it may not show, by dashboard language. */
export const FIXED_LINE: Record<string, string> = {
  en: "A task has an update",
  "zh-CN": "有个任务有了新进展",
};

/** Who the phone and dashboard holds cover, at one moment. */
interface Holds {
  watchers: ReadonlySet<ConciergeOwner>;
  active: ReadonlySet<ConciergeOwner>;
  /** The moment the holds were taken: quiet hours are judged at it. */
  at: number;
}

interface Pending {
  said: SaidInTurn & { level: NotifyLevel };
  owner: ConciergeOwner;
}

interface Waiting extends Pending {
  /** When the merge window this message waits in ends: only that window's flush sends it. */
  due: number;
}

interface ChatPushes {
  lastPushAt: number | null;
  /** The latest message said within MERGE_MS of the last push, sent when that window ends. */
  pending: Waiting | null;
}

export class ConciergePush {
  private readonly chats = new Map<string, ChatPushes>();
  /** Each chat's messages run in the order said, so a merge always keeps the latest. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(private readonly deps: ConciergePushDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  }

  /** Registers a merge timer that carries no one's session actor, whoever's turn said the message. */
  private schedule(fn: () => void, ms: number): void {
    withoutSessionActor(() => this.setTimer(fn, ms));
  }

  /**
   * Pushes a message of a turn that has a push level to its chat's owner.
   * A message held back is dropped, never pushed later. Answers at once: the
   * push never holds or fails the turn, and the message stays in the chat
   * whatever happens to it.
   */
  said(said: SaidInTurn): void {
    const { level } = said;
    if (!level) return;
    // Taken as the message is said: a hold that ends while the owner lookup
    // or an earlier message is still in the queue still drops it.
    const holds = this.holdsNow(said.chatId);
    // A message is said in whoever's scope ran the tool; the push serves the
    // chat's owner, so its queue carries no one's session actor.
    withoutSessionActor(() =>
      this.enqueue(said.chatId, () => this.handle({ ...said, level }, holds)),
    );
  }

  /** Runs `step` after every earlier step of the chat; a failure is logged, never thrown. */
  private enqueue(chatId: string, step: () => Promise<void>): void {
    const queued = (this.queues.get(chatId) ?? Promise.resolve()).then(step).catch((error) =>
      log.warn("concierge push failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    this.queues.set(chatId, queued);
    void queued.then(() => {
      if (this.queues.get(chatId) === queued) this.queues.delete(chatId);
    });
  }

  private holdsNow(chatId: string): Holds {
    return {
      watchers: this.deps.watchersOf?.(chatId) ?? new Set(),
      active: this.deps.activeOwners?.() ?? new Set(),
      at: this.now(),
    };
  }

  private async handle(said: SaidInTurn & { level: NotifyLevel }, holds: Holds): Promise<void> {
    const owner = await this.deps.ownerOf(said.chatId);
    if (!owner) return;
    // A message read or held when said is dropped: it never enters the merge
    // window, so it cannot go out once the hold clears.
    if (await this.held(said, owner, holds)) return;
    const chat = this.chatOf(said.chatId);
    const sinceLast = chat.lastPushAt === null ? Infinity : this.now() - chat.lastPushAt;
    if (sinceLast < MERGE_MS) {
      const due = (chat.lastPushAt ?? 0) + MERGE_MS;
      if (chat.pending?.due !== due) {
        this.schedule(() => this.flush(said.chatId, due), MERGE_MS - sinceLast);
      }
      chat.pending = { said, owner, due };
      return;
    }
    // The window has ended but its flush has not run yet: this newer message
    // replaces the pending one, so the older never goes out after it.
    chat.pending = null;
    await this.deliver(chat, { said, owner });
  }

  /** Sends the message waiting in the window that ends at `due`; a later window's message waits for its own flush. */
  private flush(chatId: string, due: number): void {
    this.enqueue(chatId, async () => {
      const chat = this.chats.get(chatId);
      const pending = chat?.pending;
      if (!chat || !pending || pending.due !== due) return;
      chat.pending = null;
      await this.deliver(chat, pending);
    });
  }

  private async deliver(chat: ChatPushes, { said, owner }: Pending): Promise<void> {
    const { turnId, chatId } = said;
    // Checked again at dispatch: a hold may have started while a merged push waited.
    if (await this.held(said, owner, this.holdsNow(chatId))) return;
    const at = this.now();
    const rings = chat.lastPushAt === null || at - chat.lastPushAt > RING_MS;
    const level: NotifyLevel = said.level === "active" && rings ? "active" : "passive";
    // Set before the send, so a message said while it is in flight merges.
    chat.lastPushAt = at;
    // The chat's queue never waits on Rome Cloud: a slow send holds no later message.
    void this.send(said, owner, level).catch((error: unknown) =>
      log.warn("concierge push failed", {
        turnId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async send(said: SaidInTurn, owner: ConciergeOwner, level: NotifyLevel): Promise<void> {
    const { turnId, chatId } = said;
    const words = said.private ? null : said.ownWords;
    const body = words ?? (await this.fixedLine(owner));
    const recipient = recipientOf(owner);
    const outcome = await this.deps.notify.send({
      body: pushBody(body),
      level,
      chatId,
      ...(recipient !== undefined ? { recipient } : {}),
    });
    // The outcome only: the body never reaches a log.
    log.info("concierge push", {
      turnId,
      chatId,
      level,
      recipient: recipient === undefined ? "guardian" : "visitor",
      outcome: outcome.kind,
    });
  }

  /**
   * Whether a hold covered `owner` when `holds` was taken, logging which: the
   * phone's watch, their dashboard, then their quiet hours at that moment.
   */
  private async held(
    { turnId, chatId }: SaidInTurn,
    owner: ConciergeOwner,
    holds: Holds,
  ): Promise<boolean> {
    if (holds.watchers.has(owner)) {
      log.info("concierge push skipped: the phone shows the chat", { turnId, chatId });
      return true;
    }
    if (holds.active.has(owner)) {
      log.info("concierge push held back: a dashboard is active", { turnId, chatId });
      return true;
    }
    if ((await this.deps.quietUntil(holds.at, owner)) !== null) {
      log.info("concierge push held back by quiet hours", { turnId, chatId });
      return true;
    }
    return false;
  }

  private chatOf(chatId: string): ChatPushes {
    let chat = this.chats.get(chatId);
    if (chat) return chat;
    if (this.chats.size >= CHATS_KEPT) {
      const now = this.now();
      for (const [id, kept] of this.chats) {
        if (!kept.pending && (kept.lastPushAt === null || now - kept.lastPushAt > RING_MS)) {
          this.chats.delete(id);
        }
      }
    }
    chat = { lastPushAt: null, pending: null };
    this.chats.set(chatId, chat);
    return chat;
  }

  private async fixedLine(owner: ConciergeOwner): Promise<string> {
    const language = await this.deps.language(owner).catch(() => null);
    return language && Object.hasOwn(FIXED_LINE, language) ? FIXED_LINE[language] : FIXED_LINE.en;
  }
}
