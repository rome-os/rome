// Where a Concierge message replies when it names no message.
// docs/domains/chats.md#chat-thread

import type { ConciergeService } from "./service.js";

/** What the turn's prompts are read from: the chat's store and the turns that handed prompts on. */
type TurnSource = Pick<ConciergeService, "promptsHandedOn"> & {
  deps: { webchatRepo: ConciergeService["deps"]["webchatRepo"] };
};

/** The user-role messages Concierge turn `turnId` of `chatId` took: one still queued waits for a later turn. */
export async function ownPrompts(source: TurnSource, chatId: string, turnId: string) {
  return (await source.deps.webchatRepo.getTurnChatMessages(chatId, turnId)).filter(
    (row) => row.role === "user" && row.inputState !== "queued",
  );
}

/**
 * The messages the turn answers: the ones it took, and the ones a turn a
 * newer input superseded handed on to it. An automated input counts: the
 * reply to it is placed and the message settled like any other's.
 */
export async function turnPrompts(source: TurnSource, chatId: string, turnId: string) {
  const own = (await ownPrompts(source, chatId, turnId)).map((row) => row.id);
  const handedOn = source.promptsHandedOn(chatId).filter((id) => !own.includes(id));
  return [...handedOn, ...own];
}

/**
 * The message a Concierge message that names none replies to: the turn's
 * latest guardian message when every one the turn took was said inside one
 * chat thread, a reply there and not the thread's root. Otherwise none.
 */
export async function defaultReplyTarget(source: TurnSource, chatId: string, turnId: string) {
  const prompts = await turnPrompts(source, chatId, turnId);
  const threads = new Set<string>();
  for (const key of prompts) {
    const thread = (await source.deps.webchatRepo.getReplyTarget(chatId, key))?.chatThreadId;
    if (!thread || thread === key) return undefined;
    threads.add(thread);
  }
  return threads.size === 1 ? prompts.at(-1) : undefined;
}
