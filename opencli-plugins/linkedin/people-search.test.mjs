import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from "@jackwener/opencli/errors";
import { getRegistry } from "@jackwener/opencli/registry";
import { buildPeopleSearchUrl, parsePeopleSearchLimit } from "./people-search-helpers.mjs";

const require = createRequire(import.meta.url);
const opencliRoot = resolve(dirname(require.resolve("@jackwener/opencli/registry")), "..", "..");
await import(pathToFileURL(join(opencliRoot, "clis/linkedin/people-search.js")).href);
const upstream = getRegistry().get("linkedin/people-search");
await import("./people-search.js");
const command = getRegistry().get("linkedin/people-search");

const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=example%20corp";

function payload(rows, candidates = rows.length) {
  return { rows, candidate_count: candidates, resolved_count: rows.length, layout: "strict" };
}

function row(handle, headline = "Engineer at Example Corp", location = "Austin, Texas") {
  return {
    name: "Alex Rivera",
    headline,
    location,
    profile_url: `https://www.linkedin.com/in/${handle}/`,
  };
}

function fakePage(...reads) {
  const page = {
    gotos: [],
    waits: [],
    reads: 0,
    cookies: [{ name: "JSESSIONID", value: '"ajax:0000000000"' }],
    async goto(url) {
      page.gotos.push(url);
    },
    async wait(seconds) {
      page.waits.push(seconds);
    },
    async getCookies() {
      return page.cookies;
    },
    async evaluate(script) {
      assert.match(script, /^\(function readPeopleSearchPage\(\)/);
      const next = reads[Math.min(page.reads, reads.length - 1)];
      page.reads++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return page;
}

test("the override replaces the built-in command with the same contract", () => {
  assert.notEqual(command, upstream);
  assert.deepEqual(command.columns, upstream.columns);
  assert.deepEqual(
    command.args.map(({ name, required, positional }) => ({ name, required, positional })),
    upstream.args.map(({ name, required, positional }) => ({ name, required, positional })),
  );
  assert.equal(command.access, "read");
  assert.equal(command.browser, true);
});

test("limit and URL helpers match the built-in contract", () => {
  assert.equal(parsePeopleSearchLimit(undefined), 5);
  assert.equal(parsePeopleSearchLimit(10), 10);
  for (const bad of [0, 11, -1, 1.5, "abc"]) assert.throws(() => parsePeopleSearchLimit(bad));
  assert.equal(buildPeopleSearchUrl("example corp"), SEARCH_URL);
});

test("rows keep their own metadata, rank, and the requested limit", async () => {
  const page = fakePage(
    payload([
      row("alex-rivera-a1", "Staff Engineer at Example Corp", "Austin, Texas"),
      row("alex-rivera-b2", "Product Designer at Example Corp", "Lisbon, Portugal"),
      row("alex-rivera-c3", "Data Analyst at Example Corp", ""),
    ]),
  );

  const rows = await command.func(page, { keywords: " example  corp ", limit: 2 });

  assert.deepEqual(page.gotos, [SEARCH_URL]);
  assert.deepEqual(rows, [
    { rank: 1, ...row("alex-rivera-a1", "Staff Engineer at Example Corp", "Austin, Texas") },
    { rank: 2, ...row("alex-rivera-b2", "Product Designer at Example Corp", "Lisbon, Portugal") },
  ]);
});

test("a page that is still rendering is read again without a second search", async () => {
  const page = fakePage(payload([], 0), { data: payload([row("alex-rivera-a1")]), session: "s" });

  const rows = await command.func(page, { keywords: "example corp" });

  assert.equal(rows.length, 1);
  assert.equal(page.reads, 2);
  assert.deepEqual(page.gotos, [SEARCH_URL]);
});

test("profile links without a matching result layout fail as unsupported with read-only guidance", async () => {
  const page = fakePage(payload([], 3));

  await assert.rejects(command.func(page, { keywords: "example corp", limit: 5 }), (error) => {
    assert.ok(error instanceof CommandExecutionError);
    assert.equal(error.code, "COMMAND_EXEC");
    assert.match(error.message, /layout is not supported/);
    assert.match(error.message, /3 profile link/);
    assert.match(error.hint, /Commercial Use Limit/);
    assert.ok(error.hint.includes(`opencli browser open "${SEARCH_URL}"`));
    assert.match(error.hint, /opencli browser get text main/);
    assert.match(error.hint, /opencli linkedin profile-read --profile-url/);
    return true;
  });
  assert.equal(page.reads, 2);
  assert.deepEqual(page.gotos, [SEARCH_URL]);
});

test("a search with no profile links stays an empty result", async () => {
  const page = fakePage(payload([], 0));

  await assert.rejects(command.func(page, { keywords: "example corp" }), EmptyResultError);
  assert.deepEqual(page.gotos, [SEARCH_URL]);
});

test("malformed payloads and rows without a stable profile fail closed", async () => {
  await assert.rejects(command.func(fakePage({}), { keywords: "x" }), CommandExecutionError);
  await assert.rejects(
    command.func(fakePage({ rows: [], candidate_count: -1 }), { keywords: "x" }),
    CommandExecutionError,
  );
  for (const bad of [
    null,
    { ...row("x"), profile_url: "https://example.com/in/x/" },
    { ...row("x"), name: " " },
  ]) {
    await assert.rejects(
      command.func(fakePage(payload([bad])), { keywords: "x" }),
      CommandExecutionError,
    );
  }
});

test("auth walls, redirects, and browser failures map to typed errors", async () => {
  const signedOut = fakePage(payload([row("alex-rivera-a1")]));
  signedOut.cookies = [];
  await assert.rejects(command.func(signedOut, { keywords: "x" }), AuthRequiredError);

  const malformedCookies = fakePage(payload([row("alex-rivera-a1")]));
  malformedCookies.cookies = null;
  await assert.rejects(command.func(malformedCookies, { keywords: "x" }), CommandExecutionError);

  await assert.rejects(
    command.func(
      fakePage({ error: "not on people search page", url: "https://www.linkedin.com/authwall" }),
      { keywords: "x" },
    ),
    AuthRequiredError,
  );
  await assert.rejects(
    command.func(
      fakePage({ error: "not on people search page", url: "https://www.linkedin.com/feed/" }),
      { keywords: "x" },
    ),
    /Commercial Use Limit/,
  );
  await assert.rejects(
    command.func(fakePage(new SyntaxError("Unexpected token")), { keywords: "x" }),
    CommandExecutionError,
  );

  const offline = fakePage(payload([]));
  offline.goto = async () => {
    throw new Error("navigation failed");
  };
  await assert.rejects(command.func(offline, { keywords: "x" }), CommandExecutionError);
});

test("arguments are validated before any navigation", async () => {
  for (const args of [{ keywords: "   " }, { keywords: "x", limit: 11 }]) {
    const page = fakePage(payload([]));
    await assert.rejects(command.func(page, args), ArgumentError);
    assert.deepEqual(page.gotos, []);
  }
});
