// The handoff a renewal carries from a retired session to its successor:
// what the retired session asks of the model, the port that writes it when
// the session cannot and reads what the successor's first turn shows beside
// it, and how that first turn renders it. docs/concepts/sessions.md#handoff

import { replyContextLine } from "./reply-context.js";

/** About how many tokens of the chat's recent messages a successor's first turn carries. */
export const HANDOFF_RECENT_TOKENS = 16_000;

/** About how many tokens of one agent or Rome message a handoff keeps; the guardian's are never cut. */
export const HANDOFF_AGENT_MESSAGE_TOKENS = 1_500;

/** Ends an agent message that was cut to {@link HANDOFF_AGENT_MESSAGE_TOKENS}. */
export const HANDOFF_CUT_MARKER = "… [cut; the full reply is in the chat history]";

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

/**
 * The handoff a renewal for a setup change stores: no note, since no turn
 * writes one. The successor reads what its predecessor held instead: the
 * handoff that one started from and the chat's messages since it opened.
 * docs/concepts/sessions.md#renewal
 */
export const LIGHT_HANDOFF = "";

/** One message said in the chat, as the handoff reads it. */
export interface RecentMessage {
  readonly senderName: string | null;
  readonly text: string;
  readonly at: Date;
  /** True for the agent's or Rome's message, which a handoff may cut; absent for the guardian's. */
  readonly agent?: boolean;
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
  /**
   * The context size, in tokens, past which a message that comes while that
   * renewal's handoff is written waits for the renewal, and is answered by
   * the successor. Under it, the retired session answers the message at
   * once. Absent, no message waits.
   */
  readonly hardContextLimitTokens?: number;
  /** Runs `work` while chat `chatId` says it is tidying up its context. */
  tidying<T>(chatId: string | undefined, work: () => Promise<T>): Promise<T>;
  /**
   * Writes the handoff from chat `chatId`'s recent messages with a small
   * model, after the retired session could not. Null when that fails too.
   */
  fallback(chatId: string | undefined, agentName: string): Promise<string | null>;
  /**
   * What turn `turnId` of chat `chatId` shows beside the handoff: with
   * `since`, every message said since then, else the latest ones.
   */
  context(chatId: string, turnId: string, since?: Date): Promise<HandoffContext>;
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
 * About how many tokens a light handoff carries into a successor's first
 * turn: the handoff it passes on, if any, and every message with its line.
 */
export function replayTokens(handoff: string | null, messages: readonly RecentMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message.text) + LINE_TOKENS,
    handoff ? estimateTokens(handoff) : 0,
  );
}

/**
 * The most a light handoff may carry, as a share of the context limit: a
 * provider that compacted the retired session mid-turn left it holding less
 * than the chat's text since it opened, so that text can outgrow the window.
 * Past this, the renewal writes a handoff instead.
 */
export function lightHandoffCap(contextLimitTokens: number): number {
  return Math.floor(contextLimitTokens / 2);
}

/** The first `maxTokens` tokens of `text`, by the same estimate as {@link estimateTokens}. */
function headWithin(text: string, maxTokens: number): string {
  let ascii = 0;
  let other = 0;
  let end = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1;
    else other += 1;
    if (Math.ceil(ascii / 4) + other > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The latest of `messages` (oldest first) that fit in `maxTokens`, oldest
 * first, and how many earlier ones were left out. The guardian's messages are
 * kept whole; an agent's or Rome's message over
 * {@link HANDOFF_AGENT_MESSAGE_TOKENS} is cut to its start and marked. The
 * newest message is kept even when it alone is over the cap, cut to fit.
 */
export function recentWithin(
  messages: readonly RecentMessage[],
  maxTokens: number,
): { shown: RecentMessage[]; omitted: number } {
  const shown: RecentMessage[] = [];
  let used = 0;
  let first = messages.length;
  while (first > 0) {
    let message = messages[first - 1];
    if (message.agent && estimateTokens(message.text) > HANDOFF_AGENT_MESSAGE_TOKENS) {
      message = {
        ...message,
        text: `${headWithin(message.text, HANDOFF_AGENT_MESSAGE_TOKENS)}${HANDOFF_CUT_MARKER}`,
      };
    }
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
 * notice: the handoff its predecessor wrote, when it wrote one, the chat's
 * open tasks as Rome holds them, and the chat's messages: with `all`, every
 * one the context holds, else the latest up to {@link HANDOFF_RECENT_TOKENS}.
 */
export function handoffSections(
  handoff: string | null,
  context: HandoffContext,
  options: { all?: boolean } = {},
): string[] {
  const sections = handoff
    ? [
        "Your previous session wrote this handoff for you before it was replaced. The chat's owner can open it from the chat, but has not been told about it.",
        `<handoff>\n${handoff.trim()}\n</handoff>`,
      ]
    : [];
  if (context.openTasks) {
    sections.push(
      handoff
        ? "The open tasks, as Rome holds them now. They are newer than the handoff where the two differ."
        : "The open tasks, as Rome holds them now.",
      `<open_tasks>\n${context.openTasks.trim()}\n</open_tasks>`,
    );
  }
  const { shown, omitted } = options.all
    ? { shown: [...context.recent], omitted: 0 }
    : recentWithin(context.recent, HANDOFF_RECENT_TOKENS);
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
