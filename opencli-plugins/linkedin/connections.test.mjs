import assert from "node:assert/strict";
import test from "node:test";
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from "@jackwener/opencli/errors";
import { getRegistry } from "@jackwener/opencli/registry";
import "./connections.js";

const command = () => getRegistry().get("linkedin/connections");

const conn = (id) => ({
  createdAt: 1700000000000 + id,
  miniProfile: {
    firstName: `First${id}`,
    lastName: `Last${id}`,
    occupation: `Job ${id}`,
    publicIdentifier: `user${id}`,
  },
});

const range = (from, count) => Array.from({ length: count }, (_, index) => conn(from + index));

function apiPage(elements, paging) {
  return { json: paging ? { elements, paging } : { elements } };
}

// Serves canned evaluate results in order. The first evaluate is the auth probe.
function makePage(apiResults, { authWall = false, cookies } = {}) {
  const queue = [authWall, ...apiResults];
  const evaluated = [];
  return {
    evaluated,
    goto: async () => {},
    wait: async () => {},
    getCookies: async () => cookies ?? [{ name: "JSESSIONID", value: '"ajax:12345"' }],
    evaluate: async (script) => {
      evaluated.push(script);
      if (queue.length === 0) throw new Error("unexpected extra evaluate call");
      return queue.shift();
    },
  };
}

function requestedStarts(page) {
  return page.evaluated
    .slice(1)
    .map((script) => Number(/connections\?start=(\d+)&count=\d+/.exec(script)[1]));
}

function coverageOf(rows) {
  return new Set(
    rows.map(({ total, coverage, next_offset }) =>
      JSON.stringify({ total, coverage, next_offset }),
    ),
  );
}

async function run(page, kwargs) {
  const notices = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    notices.push(String(chunk));
    return true;
  };
  try {
    const rows = await command().func(page, kwargs);
    return { rows, notices };
  } finally {
    process.stderr.write = write;
  }
}

test("a short page does not end pagination while LinkedIn reports more connections", async () => {
  const page = makePage([
    apiPage(range(0, 40), { start: 0, count: 40, total: 250 }),
    apiPage(range(40, 40), { start: 40, count: 40, total: 250 }),
    apiPage(range(80, 40), { start: 80, count: 40, total: 250 }),
    apiPage(range(120, 40), { start: 120, count: 40, total: 250 }),
    apiPage(range(160, 39), { start: 160, count: 40, total: 250 }),
    apiPage(range(199, 40), { start: 199, count: 40, total: 250 }),
    apiPage(range(239, 11), { start: 239, count: 40, total: 250 }),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 250);
  assert.deepEqual(requestedStarts(page), [0, 40, 80, 120, 160, 199, 239]);
  assert.deepEqual(rows.at(-1), {
    rank: 250,
    name: "First249 Last249",
    occupation: "Job 249",
    public_id: "user249",
    connected_at: 1700000000249,
    url: "https://www.linkedin.com/in/user249",
    total: 250,
    coverage: "complete",
    next_offset: null,
  });
  assert.deepEqual(notices, []);
});

test("a list LinkedIn stops returning before its reported total is labelled partial", async () => {
  const page = makePage([
    apiPage(range(0, 40), { total: 250 }),
    apiPage(range(40, 40), { total: 250 }),
    apiPage(range(80, 40), { total: 250 }),
    apiPage(range(120, 40), { total: 250 }),
    apiPage(range(160, 39), { total: 250 }),
    apiPage([], { total: 250 }),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 199);
  assert.deepEqual(
    coverageOf(rows),
    new Set([JSON.stringify({ total: 250, coverage: "partial", next_offset: 199 })]),
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0], /returned 199 of 250 reported connections \(coverage=partial/);
  assert.match(notices[0], /--offset 199/);
});

test("without a reported total an empty page ends the read without confirming the end", async () => {
  const page = makePage([
    apiPage(range(0, 40)),
    apiPage(range(40, 40)),
    apiPage(range(80, 40)),
    apiPage(range(120, 40)),
    apiPage(range(160, 39)),
    apiPage([]),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 199);
  assert.deepEqual(requestedStarts(page), [0, 40, 80, 120, 160, 199]);
  assert.deepEqual(
    coverageOf(rows),
    new Set([JSON.stringify({ total: null, coverage: "exhausted_unverified", next_offset: 199 })]),
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0], /returned 199 connections \(coverage=exhausted_unverified: /);
  assert.match(notices[0], /--offset 199/);
});

test("a total of 0 alongside returned connections is ignored rather than ending the read", async () => {
  const page = makePage([
    apiPage(range(0, 40), { start: 0, count: 40, total: 0 }),
    apiPage(range(40, 40), { start: 40, count: 40, total: 0 }),
    apiPage(range(80, 7), { start: 80, count: 40, total: 0 }),
    apiPage([], { start: 87, count: 40, total: 0 }),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 87);
  assert.deepEqual(requestedStarts(page), [0, 40, 80, 87]);
  assert.deepEqual(
    coverageOf(rows),
    new Set([JSON.stringify({ total: null, coverage: "exhausted_unverified", next_offset: 87 })]),
  );
  assert.equal(notices.length, 1);
});

test("a total smaller than the connections already returned is ignored", async () => {
  const page = makePage([
    apiPage(range(0, 40), { total: 30 }),
    apiPage(range(40, 40), { total: 30 }),
    apiPage([], { total: 30 }),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 80);
  assert.deepEqual(requestedStarts(page), [0, 40, 80]);
  assert.equal(rows[0].total, null);
  assert.equal(rows[0].coverage, "exhausted_unverified");
  assert.equal(notices.length, 1);
});

test("a total that later drops below the connections already returned is not trusted", async () => {
  const page = makePage([
    apiPage(range(0, 40), { total: 250 }),
    apiPage(range(40, 40), { total: 250 }),
    apiPage([], { total: 60 }),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 80);
  assert.equal(rows[0].total, null);
  assert.equal(rows[0].coverage, "exhausted_unverified");
  assert.equal(rows[0].next_offset, 80);
  assert.equal(notices.length, 1);
});

for (const [label, laterPaging] of [
  ["no", undefined],
  ["a malformed", { total: "60" }],
]) {
  test(`an earlier total is dropped once the connections returned exceed it on a page with ${label} total`, async () => {
    const page = makePage([
      apiPage(range(0, 40), { total: 60 }),
      apiPage(range(40, 40), laterPaging),
      apiPage([], laterPaging),
    ]);
    const { rows, notices } = await run(page, { limit: 500 });

    assert.equal(rows.length, 80);
    assert.deepEqual(requestedStarts(page), [0, 40, 80]);
    assert.deepEqual(
      coverageOf(rows),
      new Set([JSON.stringify({ total: null, coverage: "exhausted_unverified", next_offset: 80 })]),
    );
    assert.equal(notices.length, 1);
  });
}

test("a total that drops but still covers the connections returned is trusted", async () => {
  const page = makePage([
    apiPage(range(0, 40), { total: 250 }),
    apiPage(range(40, 40), { total: 80 }),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 80);
  assert.equal(rows[0].total, 80);
  assert.equal(rows[0].coverage, "complete");
  assert.equal(rows[0].next_offset, null);
  assert.deepEqual(notices, []);
});

test("stopping at --limit reports the offset to continue from", async () => {
  const page = makePage([
    apiPage(range(0, 40), { total: 250 }),
    apiPage(range(40, 10), { total: 250 }),
  ]);
  const { rows, notices } = await run(page, { limit: 50 });

  assert.equal(rows.length, 50);
  assert.match(page.evaluated[2], /connections\?start=40&count=10/);
  assert.equal(rows[0].coverage, "limit");
  assert.equal(rows[0].next_offset, 50);
  assert.match(
    notices[0],
    /returned 50 of 250 reported connections \(coverage=limit: --limit reached\)/,
  );
});

test("--limit equal to the reported total is complete, not truncated", async () => {
  const page = makePage([apiPage(range(0, 20), { total: 20 })]);
  const { rows, notices } = await run(page, { limit: 20 });

  assert.equal(rows[0].coverage, "complete");
  assert.deepEqual(notices, []);
});

test("--offset continues from a previous next_offset", async () => {
  const page = makePage([apiPage(range(50, 40), { total: 90 })]);
  const { rows } = await run(page, { limit: 100, offset: 50 });

  assert.match(page.evaluated[1], /connections\?start=50&count=40/);
  assert.equal(rows[0].public_id, "user50");
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].coverage, "complete");
});

test("entries repeated across overlapping pages appear once", async () => {
  const page = makePage([
    apiPage(range(0, 39), { total: 80 }),
    apiPage([conn(38), ...range(39, 39)], { total: 80 }),
    apiPage(range(78, 2), { total: 80 }),
  ]);
  const { rows } = await run(page, { limit: 500 });

  assert.equal(rows.length, 80);
  assert.equal(new Set(rows.map((row) => row.public_id)).size, 80);
  assert.deepEqual(
    rows.map((row) => row.rank),
    Array.from({ length: 80 }, (_, index) => index + 1),
  );
});

test("reaching the reported total with duplicates in place of entries is partial", async () => {
  const page = makePage([
    apiPage(range(0, 40), { total: 80 }),
    apiPage([conn(39), ...range(40, 39)], { total: 80 }),
    apiPage([], { total: 80 }),
  ]);
  const { rows, notices } = await run(page, { limit: 500 });

  assert.equal(rows.length, 79);
  assert.deepEqual(requestedStarts(page), [0, 40, 80]);
  assert.equal(rows[0].total, 80);
  assert.equal(rows[0].coverage, "partial");
  assert.equal(rows[0].next_offset, 80);
  assert.equal(notices.length, 1);
});

test("the request budget bounds pagination when LinkedIn returns tiny pages", async () => {
  const pages = Array.from({ length: 10 }, (_, index) => apiPage([conn(index)], { total: 999 }));
  const page = makePage(pages);
  const { rows, notices } = await run(page, { limit: 40 });

  assert.equal(page.evaluated.length - 1, 4);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].coverage, "partial");
  assert.equal(rows[0].next_offset, 4);
  assert.equal(notices.length, 1);
});

test("an empty first page with a positive reported total fails instead of claiming no connections", async () => {
  const page = makePage([apiPage([], { total: 12 })]);
  await assert.rejects(run(page, { limit: 20 }), CommandExecutionError);
});

test("no connections at all is an empty result", async () => {
  const page = makePage([apiPage([], { total: 0 })]);
  await assert.rejects(run(page, { limit: 20 }), EmptyResultError);
});

test("auth walls and auth failures fail closed", async () => {
  await assert.rejects(run(makePage([], { authWall: true }), { limit: 2 }), AuthRequiredError);
  await assert.rejects(run(makePage([], { cookies: [] }), { limit: 2 }), AuthRequiredError);
  await assert.rejects(
    run(makePage([{ authRequired: true, error: "HTTP 403" }]), { limit: 2 }),
    AuthRequiredError,
  );
});

test("a failure after earlier pages fails closed instead of returning the subset", async () => {
  const page = makePage([apiPage(range(0, 40), { total: 80 }), { error: "HTTP 500" }]);
  await assert.rejects(run(page, { limit: 80 }), CommandExecutionError);
});

test("malformed payloads fail closed", async () => {
  await assert.rejects(run(makePage([{ json: {} }]), { limit: 2 }), CommandExecutionError);
  await assert.rejects(
    run(makePage([apiPage([{ createdAt: 1 }])]), { limit: 2 }),
    CommandExecutionError,
  );
  await assert.rejects(
    run(
      makePage([
        apiPage([{ createdAt: 1, miniProfile: { firstName: "Bad", publicIdentifier: "bad/id" } }]),
      ]),
      { limit: 2 },
    ),
    CommandExecutionError,
  );
});

test("invalid --limit and --offset are argument errors", async () => {
  await assert.rejects(run(makePage([]), { limit: 0 }), ArgumentError);
  await assert.rejects(run(makePage([]), { limit: 501 }), ArgumentError);
  await assert.rejects(run(makePage([]), { limit: 20, offset: -1 }), ArgumentError);
});
