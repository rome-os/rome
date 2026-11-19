import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEEPSEEK_MODEL,
  DEEPSEEK_URL,
  HIGHLIGHT_LIMIT,
  highlightsPrompt,
  validateHighlights,
  writeHighlights,
} from "./release-highlights.mjs";

const notes = {
  breaking: [{ scope: "core", text: "drop the old sign-in", pr: 10 }],
  new: [
    { scope: "web", text: "dictate messages", pr: 11 },
    { scope: "ci", text: "a direct push", pr: null },
  ],
  fixes: [{ scope: "ios", text: "keep drafts", pr: 12 }],
};
const pulls = new Map([
  [11, { title: "feat(web): dictate messages (#11)", body: "x".repeat(5000) }],
]);

/** A stub DeepSeek that answers `content` as the model's message, recording each request. */
function model(content, { status = 200 } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: typeof content === "string" ? content : JSON.stringify(content) } },
        ],
      }),
      { status },
    );
  };
  return { fetch, requests };
}

test("the prompt gives the model each cited entry with its pull request", () => {
  const [system, user] = highlightsPrompt(notes, pulls);
  assert.equal(system.role, "system");
  assert.match(system.content, /feature gate/);
  assert.match(system.content, /Improved security/);
  const changes = JSON.parse(user.content);
  assert.deepEqual(
    changes.new.map((c) => c.pr),
    [11],
  );
  assert.equal(changes.new[0].title, "feat(web): dictate messages (#11)");
  assert.equal(changes.new[0].description.length, 3000);
  assert.equal(changes.fixes[0].title, null);
});

test("validation keeps cited, short, single highlights and moves breaking ones first", () => {
  const raw = {
    en: [
      { text: "Dictate  messages\nby voice.", pr: 11 },
      { text: "Invented", pr: 999 },
      { text: "Duplicate", pr: 11 },
      { text: "", pr: 12 },
      { text: "y".repeat(201), pr: 12 },
      { text: "Sign in again after upgrading.", pr: 10 },
      { text: 12, pr: 12 },
      { text: "Number as string", pr: "12" },
      null,
    ],
    zh: [{ text: "语音输入消息。", pr: 11 }],
    fr: [{ text: "ignored", pr: 11 }],
  };
  assert.deepEqual(validateHighlights(raw, notes), {
    en: [
      { text: "Sign in again after upgrading.", pr: 10 },
      { text: "Dictate messages by voice.", pr: 11 },
    ],
    zh: [{ text: "语音输入消息。", pr: 11 }],
  });
});

test("validation caps each language and reads a malformed answer as none", () => {
  const many = {
    breaking: [],
    new: [1, 2, 3, 4, 5, 6, 7].map((pr) => ({ scope: null, text: "t", pr })),
    fixes: [],
  };
  const raw = { en: many.new.map(({ pr }) => ({ text: `Change ${pr}`, pr })) };
  assert.equal(validateHighlights(raw, many).en.length, HIGHLIGHT_LIMIT);
  assert.deepEqual(validateHighlights(raw, many).zh, []);
  assert.deepEqual(validateHighlights(null, notes), { en: [], zh: [] });
  assert.deepEqual(validateHighlights([], notes), { en: [], zh: [] });
  assert.deepEqual(validateHighlights({ en: "x" }, notes), { en: [], zh: [] });
});

test("the model is asked once with the key, and its invented pull requests are dropped", async () => {
  const stub = model({
    en: [
      { text: "Dictate messages by voice.", pr: 11 },
      { text: "A change it made up.", pr: 4242 },
    ],
    zh: [{ text: "语音输入消息。", pr: 11 }],
  });
  const highlights = await writeHighlights({ notes, pulls, apiKey: "sk-test", fetch: stub.fetch });
  assert.deepEqual(highlights, {
    en: [{ text: "Dictate messages by voice.", pr: 11 }],
    zh: [{ text: "语音输入消息。", pr: 11 }],
  });
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].url, DEEPSEEK_URL);
  assert.equal(stub.requests[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(stub.requests[0].body.model, DEEPSEEK_MODEL);
  assert.deepEqual(stub.requests[0].body.response_format, { type: "json_object" });
});

test("any failure, a missing key or nothing to cite leaves the release without highlights", async (t) => {
  t.mock.method(console, "error", () => {});
  const none = { en: [], zh: [] };
  for (const stub of [model("not json"), model({}, { status: 500 }), model(null)]) {
    assert.deepEqual(await writeHighlights({ notes, pulls, apiKey: "k", fetch: stub.fetch }), none);
  }
  const thrown = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await writeHighlights({ notes, pulls, apiKey: "k", fetch: thrown }), none);

  const unused = model({ en: [{ text: "x", pr: 11 }] });
  assert.deepEqual(
    await writeHighlights({ notes, pulls, apiKey: undefined, fetch: unused.fetch }),
    none,
  );
  const uncited = { breaking: [], new: [{ scope: null, text: "t", pr: null }], fixes: [] };
  assert.deepEqual(
    await writeHighlights({ notes: uncited, pulls, apiKey: "k", fetch: unused.fetch }),
    none,
  );
  assert.equal(unused.requests.length, 0);
});
