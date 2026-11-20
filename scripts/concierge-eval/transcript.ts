// A scenario chat as the judge and the checks read it: the owner's messages,
// the Concierge's text, the cards it composed, and each reaction the
// Concierge put on an owner message, which answers it as a reply would.
// docs/concierge-eval.md#baseline

import { type ChatMessage, partsOf } from "./api.js";

export function textOf(message: ChatMessage): string {
  return partsOf(message)
    .filter((p) => p.type === "text")
    .map((p) => String(p.content ?? p.text ?? ""))
    .join("\n")
    .trim();
}

/** The plain-text line of an agent card the Concierge composed, or null for any other message. */
export function cardTextOf(message: ChatMessage): string | null {
  const card = partsOf(message).find((p) => p.type === "widget" && p.appId === "core" && p.ui);
  return card ? String(card.text ?? "").trim() : null;
}

const isOwner = (m: ChatMessage) =>
  m.role === "user" && partsOf(m).some((p) => p.type === "text") && textOf(m) !== "";

export interface Transcript {
  /** One line per owner message, Concierge text and reaction, in order. */
  lines: string[];
  /** The Concierge's text messages after each owner message, in order. */
  saidAfter: string[][];
  /** The plain-text lines of the cards the Concierge composed after each owner message. */
  cardsAfter: string[][];
  /** The Concierge's reaction to each owner message, in order; null for none. */
  reactions: (string | null)[];
}

export function transcriptOf(messages: ChatMessage[]): Transcript {
  const lines: string[] = [];
  const saidAfter: string[][] = [];
  const cardsAfter: string[][] = [];
  const reactions: (string | null)[] = [];
  for (const m of messages) {
    if (isOwner(m)) {
      saidAfter.push([]);
      cardsAfter.push([]);
      reactions.push(m.reaction ?? null);
      lines.push(`OWNER: ${textOf(m)}`);
      if (m.reaction) lines.push(`ASSISTANT reacted to that message with ${m.reaction}`);
    } else if (m.role === "assistant") {
      const card = cardTextOf(m);
      if (card !== null) {
        cardsAfter.at(-1)?.push(card);
        lines.push(`ASSISTANT showed a card, whose plain text reads: ${card}`);
        continue;
      }
      const text = textOf(m);
      if (!text) continue;
      saidAfter.at(-1)?.push(text);
      lines.push(`ASSISTANT: ${text}`);
    }
  }
  return { lines, saidAfter, cardsAfter, reactions };
}
