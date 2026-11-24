// The scenario can only be scored mechanically if no filler or silence
// message can hold a value, and a reply is matched on the value alone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judge } from "../lib/places.mjs";
import {
  _forTests,
  drawFacts,
  drawValues,
  fillers,
  holdsValue,
  workRequest,
} from "../lib/scenario.mjs";

it("no filler or silence message holds a digit or a value word", () => {
  const texts = [..._forTests.FILLER, ...Object.values(_forTests.SILENCE).flat()];
  for (const t of texts) {
    assert.doesNotMatch(t, /\d/, t);
    for (const w of _forTests.WORDS) assert.ok(!t.toUpperCase().includes(w), `${t} holds ${w}`);
  }
  assert.equal(Object.values(_forTests.SILENCE).flat().length, 50);
});

it("no text the members say reads as a secret, a lock, a login or money", () => {
  // An agent may rightly decline to repeat a credential, so a scenario built
  // on one would fail the product for good behavior.
  const secret =
    /\b(password|passcode|code\w*|pin|keys?|secrets?|tokens?|locks?|locker|doors?|log ?in|logins?|credentials?|wifi|money|budget|invoice|bank|cash|pay\w*|price|card|voucher)\b/i;
  const t = _forTests;
  const v = "OSPREY-48213";
  const texts = [
    ...t.TOPICS.flatMap((topic) => [topic, ...t.QUALIFIERS.map((q) => `${topic} ${q}`)]),
    ...t.TOPICS.flatMap((topic) => [
      ...t.FACTS.map((f) => f(topic, v)),
      ...t.QUESTIONS.map((q) => q(topic)),
    ]),
    ...t.ECHO.map((e) => e(v)),
    ...t.PRIVATE.map((e) => e(v)),
    t.WORK("OSPREY", 101, 202),
    ...t.FILLER,
    ...Object.values(t.SILENCE).flat(),
  ];
  for (const text of texts) assert.doesNotMatch(text, secret, text);
});

it("each fact in a draw has its own topic and word", () => {
  const facts = drawFacts(21);
  assert.equal(new Set(facts.map((f) => f.topic)).size, 21);
  assert.equal(new Set(facts.map((f) => f.word)).size, 21);
  assert.equal(fillers(10).length, 10);
});

it("matches the value however the reply writes it, and not a longer number", () => {
  const fact = { word: "OSPREY", number: "4821" };
  assert.ok(holdsValue("It's OSPREY-4821.", fact));
  assert.ok(holdsValue("the code is osprey 4821", fact));
  assert.ok(!holdsValue("OSPREY-48210", fact));
  assert.ok(!holdsValue("It was 4821", fact));
  assert.ok(!holdsValue(undefined, fact));
  assert.ok(holdsValue("**OSPREY**-4821", fact));
  assert.ok(!holdsValue("OSPREY and later 4821", fact));
  assert.ok(holdsValue("the answer is OSPREY-544,617", { word: "OSPREY", number: "544617" }));
  assert.ok(!holdsValue("OSPREY-544,6170", { word: "OSPREY", number: "544617" }));
});

it("no two values of a run share a number, and work's value is not in its request", () => {
  const values = drawValues(200);
  assert.equal(new Set(values.map((v) => v.number)).size, 200);
  const work = workRequest();
  assert.ok(!holdsValue(work.text, work));
});

it("a qualified draw for rule 6 holds 60 distinct topics", () => {
  assert.equal(new Set(drawFacts(60, { qualified: true }).map((f) => f.topic)).size, 60);
});

describe("where an answer landed", () => {
  const value = { word: "OSPREY", number: "48213" };
  const open = { channel: "C1", threadTs: null, ts: "10.1", value };
  const inThread = { channel: "C1", threadTs: "5.0", ts: "10.2", value };
  const dm = { dm: true, channel: "D1", threadTs: null, ts: "10.3", value };
  const verdict = (q, posts) => judge([q], posts)[0].verdict;
  const post = (channel, threadTs, text = "OSPREY-48213") => ({
    channel,
    threadTs,
    ts: "11.0",
    text,
  });

  it("takes the open chat or a thread on the question for a question asked in the open chat", () => {
    assert.equal(verdict(open, [post("C1", null)]), "answered");
    assert.equal(verdict(open, [post("C1", "10.1")]), "answered");
    assert.equal(verdict(open, [post("C1", "5.0")]), "misplaced");
  });

  it("takes only its thread for a question asked in a thread", () => {
    assert.equal(verdict(inThread, [post("C1", "5.0")]), "answered");
    assert.equal(verdict(inThread, [post("C1", null)]), "misplaced");
  });

  it("counts a value seen elsewhere as misplaced even when it also landed right", () => {
    assert.equal(verdict(dm, [post("D1", null), post("C2", null)]), "misplaced");
    assert.equal(verdict(dm, [post("D2", null)]), "misplaced");
  });

  it("counts a reply without the value as unanswered", () => {
    assert.equal(verdict(open, [post("C1", null, "I don't know")]), "unanswered");
  });
});
