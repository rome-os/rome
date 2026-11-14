import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import { questionCardUi } from "../agent/index.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { backfillQuestionCards, describeQuestionCards } from "./question-card-backfill.js";

const questions = [
  { id: "q1", question: "Which colour?", type: "single", options: ["Red", "Blue"] },
];

function card(toolUseId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "pending_interaction",
    toolUseId,
    appId: "core",
    render: {
      kind: "inline",
      componentId: "question-card",
      props: { questions },
      builtin: true,
      ...extra,
    },
  };
}

function answer(toolUseId: string, output: Record<string, unknown>) {
  return { type: "interaction_result", toolUseId, output };
}

describe("describeQuestionCards", () => {
  it("describes an old card and gives its answer the card it would have sent", () => {
    const changed = describeQuestionCards([
      { id: "1", parts: [{ type: "text", text: "Pick one" }, card("t1")] },
      { id: "2", parts: [answer("t1", { answers: [{ questionId: "q1", value: "Blue" }] })] },
    ]);
    expect(changed).toEqual([
      {
        id: "1",
        parts: [
          { type: "text", text: "Pick one" },
          card("t1", { ui: questionCardUi(questions as never) }),
        ],
      },
      {
        id: "2",
        parts: [
          answer("t1", {
            answers: [{ questionId: "q1", value: "Blue" }],
            card: [{ values: ["Blue"], text: "" }],
          }),
        ],
      },
    ]);
  });

  it("leaves described cards, dismissals and answers to other cards alone", () => {
    const described = card("t1", { ui: { components: [] } });
    const changed = describeQuestionCards([
      { id: "1", parts: [described] },
      {
        id: "2",
        parts: [answer("t1", { answers: [{ questionId: "q1", value: "Red" }], card: [] })],
      },
      { id: "3", parts: [card("t2")] },
      { id: "4", parts: [answer("t2", { dismissed: true })] },
      { id: "5", parts: [answer("t3", { answers: [{ questionId: "q1", value: "Red" }] })] },
    ]);
    expect(changed.map((m) => m.id)).toEqual(["3"]);
  });

  it("skips a card whose questions do not parse", () => {
    const broken = { ...card("t1"), render: { componentId: "question-card", props: { nope: 1 } } };
    expect(describeQuestionCards([{ id: "1", parts: [broken] }])).toEqual([]);
  });
});

describe("backfillQuestionCards", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => testDb.close());

  it("describes stored cards in both stores once, and does nothing the second time", () => {
    const { db } = testDb;
    db.run(sql`INSERT INTO "chats" ("id", "platform", "key", "kind", "started_at")
      VALUES (1, 'webchat', 'c1', 'dm', 0)`);
    const said = (key: string, at: number, parts: unknown[]) =>
      db.run(sql`INSERT INTO "chat_messages" ("chat_id", "key", "text", "parts", "said_at")
        VALUES (1, ${key}, '', ${JSON.stringify(parts)}, ${at})`);
    said("m1", 1, [card("t1")]);
    said("m2", 2, [answer("t1", { answers: [{ questionId: "q1", value: "Red" }] })]);
    db.run(sql`INSERT INTO "rome_agent_messages" ("id", "session_id", "role", "content", "created_at")
      VALUES ('a1', 's1', 'assistant', ${JSON.stringify([card("t9")])}, 0)`);

    expect(backfillQuestionCards(db)).toBe(3);
    expect(backfillQuestionCards(db)).toBe(0);

    const stored = db
      .all<{ parts: string }>(sql`SELECT "parts" FROM "chat_messages" ORDER BY "said_at"`)
      .map((r) => JSON.parse(r.parts));
    expect(stored[0][0].render.ui).toEqual(questionCardUi(questions as never));
    expect(stored[1][0].output.card).toEqual([{ values: ["Red"], text: "" }]);
    const [legacy] = db.all<{ content: string }>(sql`SELECT "content" FROM "rome_agent_messages"`);
    expect(JSON.parse(legacy!.content)[0].render.ui).toEqual(questionCardUi(questions as never));
  });
});
