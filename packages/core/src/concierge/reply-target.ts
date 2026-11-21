// The guardian messages a Concierge turn answers.
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
