// Question cards stored before cards were described as data
// (rome-os/rome#2068) carry only their questions, so the dashboard and the
// iOS app draw them as a line of text. This backfill gives each one the card
// described from its questions (`render.ui`), and each answer to one the card
// the guardian would have sent (`card`), so readers draw them as any card.
// It runs once, at startup: a `settings` key records the run, since every
// card stored from then on carries its description.

import { sql } from "drizzle-orm";
import {
  parseAskQuestionInput,
  type Question,
  questionCardFromAnswers,
  questionCardUi,
} from "../agent/index.js";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("question-card-backfill");

/** A message's parts as one of the two stores holds them. */
export interface StoredMessage {
  id: string;
  parts: unknown[];
}

/** Set in `settings` once the backfill has run. */
const DONE_KEY = "backfill.questionCardsDescribed";

interface Store {
  /** The chats (or sessions) holding a question card. */
  pending: ReturnType<typeof sql>;
  /** Every message of one chat, in the order it was said. */
  messages: (chat: string | number) => ReturnType<typeof sql>;
  update: (id: string, parts: string) => ReturnType<typeof sql>;
}

const CARD = '%"componentId":"question-card"%';

const STORES: Store[] = [
  {
    pending: sql`SELECT DISTINCT "chat_id" AS "chat" FROM "chat_messages"
      WHERE "parts" LIKE ${CARD}`,
    messages: (chat) => sql`SELECT CAST("id" AS TEXT) AS "id", "parts" FROM "chat_messages"
      WHERE "chat_id" = ${chat} ORDER BY "said_at", "chat_messages"."id"`,
    update: (id, parts) =>
      sql`UPDATE "chat_messages" SET "parts" = ${parts} WHERE "id" = ${Number(id)}`,
  },
  {
    pending: sql`SELECT DISTINCT "session_id" AS "chat" FROM "rome_agent_messages"
      WHERE "role" = 'assistant' AND "content" LIKE ${CARD}`,
    messages: (chat) => sql`SELECT "id", "content" AS "parts" FROM "rome_agent_messages"
      WHERE "session_id" = ${chat} AND "role" IN ('assistant', 'user') ORDER BY "created_at", "rowid"`,
    update: (id, parts) =>
      sql`UPDATE "rome_agent_messages" SET "content" = ${parts} WHERE "id" = ${id}`,
  },
];

/** Describe every stored question card that has no description, and the
 *  answers to them, in one transaction, unless that has run before. Answers
 *  how many messages changed. */
export function backfillQuestionCards(db: DrizzleDb): number {
  const changed = db.transaction((tx) => {
    const [done] = tx.all<{ n: number }>(
      sql`SELECT count(*) AS "n" FROM "settings" WHERE "key" = ${DONE_KEY}`,
    );
    if (done && done.n > 0) return 0;
    let count = 0;
    for (const store of STORES) {
      for (const { chat } of tx.all<{ chat: string | number }>(store.pending)) {
        const rows = tx.all<{ id: string; parts: string }>(store.messages(chat));
        for (const message of describeQuestionCards(rows.flatMap(parseRow))) {
          tx.run(store.update(message.id, JSON.stringify(message.parts)));
          count += 1;
        }
      }
    }
    tx.run(sql`INSERT INTO "settings" ("key", "value", "updated_at")
      VALUES (${DONE_KEY}, 'true', ${Math.floor(Date.now() / 1000)})`);
    return count;
  });
  if (changed > 0) log.info("described stored question cards", { messages: changed });
  return changed;
}

function parseRow(row: { id: string; parts: string }): StoredMessage[] {
  try {
    const parts = JSON.parse(row.parts) as unknown;
    return Array.isArray(parts) ? [{ id: row.id, parts }] : [];
  } catch {
    return [];
  }
}

/**
 * The messages of one chat, in order, whose question cards or answers it
 * changed: a card with no description gets one from its questions, and an
 * answer to such a card gets the card the guardian would have sent. An answer
 * goes to the newest card before it with its tool-use id.
 */
export function describeQuestionCards(messages: readonly StoredMessage[]): StoredMessage[] {
  const open = new Map<string, Question[]>();
  const changed: StoredMessage[] = [];
  for (const message of messages) {
    let touched = false;
    const parts = message.parts.map((part) => {
      if (!isObject(part) || typeof part.toolUseId !== "string") return part;
      const render = isObject(part.render) ? part.render : undefined;
      // Core's own question card only: an app may name a card the same.
      if (
        part.type === "pending_interaction" &&
        part.appId === "core" &&
        render?.builtin === true &&
        render.componentId === "question-card"
      ) {
        const parsed = parseAskQuestionInput(render.props);
        if (!parsed.ok) return part;
        open.set(part.toolUseId, parsed.questions);
        if (render.ui !== undefined) return part;
        touched = true;
        return { ...part, render: { ...render, ui: questionCardUi(parsed.questions) } };
      }
      if (part.type === "interaction_result") {
        const questions = open.get(part.toolUseId);
        open.delete(part.toolUseId);
        const output = isObject(part.output) ? part.output : undefined;
        if (!questions || !output || output.card !== undefined || output.dismissed === true) {
          return part;
        }
        const card = cardFromAnswers(questions, output);
        if (!card) return part;
        touched = true;
        return { ...part, output: { ...output, card } };
      }
      return part;
    });
    if (touched) changed.push({ id: message.id, parts });
  }
  return changed;
}

/** What the card would have sent for an answer, or null for an answer stored
 *  in a shape it cannot read: one bad answer leaves that answer as it is
 *  rather than stopping Rome from starting. */
function cardFromAnswers(questions: readonly Question[], output: unknown) {
  try {
    return questionCardFromAnswers(questions, output);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
