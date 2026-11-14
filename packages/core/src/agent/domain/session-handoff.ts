// The handoff a renewal carries from a retired session to its successor:
// what the retired session asks of the model, the port that writes it when
// the session cannot and reads what the successor's first turn shows beside
// it, and how that first turn renders it. docs/concepts/sessions.md#handoff

import { replyContextLine } from "./reply-context.js";

/** About how many tokens of the chat's recent messages a successor's first turn carries. */
export const HANDOFF_RECENT_TOKENS = 8_000;

/** What a message's line costs besides its text: its time and sender. */
const LINE_TOKENS = 12;

/**
 * What the retired session is asked, in a turn that reaches no chat. The
 * chat's owner can open the note from the chat's renewal line, so it is
 * written for them to read.
 */
export const HANDOFF_REQUEST = [
  "<handoff_request>",
  "This session is about to be replaced by a fresh one, which will not see this conversation.",
  "Write a handoff note for it. The person this chat serves can open the note from the chat, so write only what you would say to them; nothing else of this turn is sent to anyone.",
  "Do not call any tool. Do not answer or address the guardian. Reply with the note alone.",
  "Cover, in short bullet points under these headings:",
  "- In progress: what you were doing or about to do.",
  "- Agreed: decisions, preferences and promises made with the guardian, in their words where it matters.",
  "- Still open: questions waiting on the guardian or on others, and anything you said you would come back to.",
  "- Ids: the task ids, chat ids and other ids the work above refers to.",
  "Leave out what the conversation settled and no longer needs. Write in the conversation's language. Keep it under 500 words.",
  "</handoff_request>",
].join("\n");

/** One message said in the chat, as the handoff reads it. */
export interface RecentMessage {
  readonly senderName: string | null;
  readonly text: string;
  readonly at: Date;
}

/**
 * Added to the system prompt of the turn that writes a handoff. A Codex thread
 * keeps the tools it was opened with, so the model may still see them listed;
 * Rome refuses every call.
 */
export const HANDOFF_TURN_INSTRUCTION = [
  "<rome_handoff_turn>",
  "This is a private side turn that writes a handoff note. Do not invoke any tool, even if tools from earlier in this thread are listed: every call is refused. Answer only from the conversation so far.",
  "</rome_handoff_turn>",
].join("\n");

/** What a successor's first turn shows beside its handoff, read from Rome when the turn runs. */
export interface HandoffContext {
  /** The open tasks of the chat, rendered by whoever keeps them, or null for none. */
  openTasks: string | null;
  /** The chat's latest messages before the turn, oldest first. */
  recent: readonly RecentMessage[];
}

/**
 * Port. What a renewal with a handoff needs from outside the agent context.
 * Absent, no renewal writes a handoff.
 */
export interface RenewalHandoffs {
  /** How long the retired session has to write its handoff before the fallback writes it. */
  readonly timeoutMs: number;
  /**
   * The context size, in tokens, past which a session that renews with a
   * handoff is renewed once its turn ends. Absent, only a setup change or a
   * reset renews it.
   */
  readonly contextLimitTokens?: number;
  /** Runs `work` while chat `chatId` says it is tidying up its context. */
  tidying<T>(chatId: string | undefined, work: () => Promise<T>): Promise<T>;
  /**
   * Writes the handoff from chat `chatId`'s recent messages with a small
   * model, after the retired session could not. Null when that fails too.
   */
  fallback(chatId: string | undefined, agentName: string): Promise<string | null>;
  /** What turn `turnId` of chat `chatId` shows beside the handoff. */
  context(chatId: string, turnId: string): Promise<HandoffContext>;
}

/**
 * A rough count of the tokens `text` takes: a token per four characters of
 * Latin script, and one for every other character, as CJK text runs.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

/**
 * The latest of `messages` (oldest first) that fit in `maxTokens`, oldest
 * first, and how many earlier ones were left out. The newest message is kept
 * even when it alone is over the cap, cut to fit.
 */
export function recentWithin(
  messages: readonly RecentMessage[],
  maxTokens: number,
): { shown: RecentMessage[]; omitted: number } {
  const shown: RecentMessage[] = [];
  let used = 0;
  let first = messages.length;
  while (first > 0) {
    const message = messages[first - 1];
    const cost = estimateTokens(message.text) + LINE_TOKENS;
    if (used + cost > maxTokens) {
      if (shown.length === 0) {
        // Cut by characters: a CJK character can be a token on its own.
        shown.push({ ...message, text: `${message.text.slice(0, maxTokens)}…` });
        first -= 1;
      }
      break;
    }
    used += cost;
    shown.push(message);
    first -= 1;
  }
  return { shown: shown.reverse(), omitted: first };
}

/**
 * The sections a successor's first turn carries inside its `<continuation>`
 * notice: the handoff its predecessor wrote, the chat's open tasks as Rome
 * holds them, and the chat's latest messages up to {@link HANDOFF_RECENT_TOKENS}.
 */
export function handoffSections(handoff: string, context: HandoffContext): string[] {
  const sections = [
    "Your previous session wrote this handoff for you before it was replaced. The chat's owner can open it from the chat, but has not been told about it.",
    `<handoff>\n${handoff.trim()}\n</handoff>`,
  ];
  if (context.openTasks) {
    sections.push(
      "The open tasks, as Rome holds them now. They are newer than the handoff where the two differ.",
      `<open_tasks>\n${context.openTasks.trim()}\n</open_tasks>`,
    );
  }
  const { shown, omitted } = recentWithin(context.recent, HANDOFF_RECENT_TOKENS);
  if (shown.length > 0) {
    sections.push(
      "<recent_messages>",
      ...(omitted > 0 ? [`[${omitted} earlier messages omitted]`] : []),
      ...shown.map((message) =>
        replyContextLine({
          createdAt: message.at,
          sender: message.senderName?.trim() || "Unknown sender",
          text: message.text,
        }),
      ),
      "</recent_messages>",
    );
  }
  return sections;
}
