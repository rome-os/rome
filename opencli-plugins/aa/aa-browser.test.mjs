import assert from "node:assert/strict";
import test from "node:test";
import { AaLoginRequiredError, loadAaFlights } from "./aa-browser.mjs";
import { buildSearchUrl } from "./aa-helpers.mjs";
import { fixture, mockPage, searchFor } from "./test-fixtures.mjs";

test("navigates fresh and waits for a stable complete result set", async () => {
  const d = fixture();
  const p = mockPage([
    { ...d, ready: false },
    { ...d, loading: true },
    { ...d, rows: d.rows.slice(0, 2) },
    d,
  ]);
  assert.deepEqual(await loadAaFlights(p, searchFor(), { now: p.now }), d);
  assert.deepEqual(p.urls, ["about:blank", buildSearchUrl(searchFor())]);
  assert.ok(p.now() >= 4000);
});
for (const [key, pattern] of [
  ["challenge", /challenge/],
  ["expired", /expired/],
  ["login_required", /Log in/],
  ["error", /could not complete/],
])
  test(`fails on ${key}`, async () => {
    const p = mockPage([{ ...fixture(), [key]: true }]);
    await assert.rejects(loadAaFlights(p, searchFor(), { now: p.now }), pattern);
  });
test("login errors are distinguishable and never trigger cash fallback", async () => {
  const p = mockPage([{ ...fixture(), login_required: true }]);
  await assert.rejects(loadAaFlights(p, searchFor("award"), { now: p.now }), AaLoginRequiredError);
  assert.equal(p.urls.length, 2);
  assert.ok(p.urls[1].includes("searchType=Award"));
});
test("remembers the highest expected count across a count regression", async () => {
  const d = fixture();
  const p = mockPage([d, { ...d, expected_count: 2, rows: d.rows.slice(0, 2) }]);
  await assert.rejects(
    loadAaFlights(p, searchFor("cash", { timeout: 5 }), { now: p.now }),
    /No partial/,
  );
});
test("never emits a stable partial page", async () => {
  const d = fixture();
  const p = mockPage([{ ...d, rows: d.rows.slice(0, 1) }]);
  await assert.rejects(
    loadAaFlights(p, searchFor("cash", { timeout: 5 }), { now: p.now }),
    /No partial/,
  );
});
test("does not equate a transient zero result count with no availability", async () => {
  const p = mockPage([{ ...fixture(), rows: [], expected_count: 0 }]);
  await assert.rejects(
    loadAaFlights(p, searchFor("cash", { timeout: 5 }), { now: p.now }),
    /No partial/,
  );
});
test("waits for stable explicitly empty results", async () => {
  const d = { ...fixture(), rows: [], expected_count: 0, no_results: true };
  const p = mockPage([d]);
  assert.deepEqual(await loadAaFlights(p, searchFor(), { now: p.now }), d);
});
test("rejects stale search conditions before returning fares", async () => {
  const d = fixture();
  d.search.miles = true;
  const p = mockPage([d]);
  await assert.rejects(loadAaFlights(p, searchFor(), { now: p.now }), /miles/);
});

test("waits for date hydration even when the grid is mounted and complete", async () => {
  const d = fixture("round-award");
  const early = structuredClone(d);
  early.search.depart = "";
  early.search.return_date = "";
  const p = mockPage([early, early, d]);
  assert.deepEqual(await loadAaFlights(p, searchFor("round-award"), { now: p.now }), d);
  assert.ok(p.now() >= 3000);
});
test("retries transient navigation context destruction, not arbitrary evaluate failures", async () => {
  const p = mockPage([fixture()]);
  const read = p.evaluate;
  let first = true;
  p.evaluate = async (fn) => {
    if (first) {
      first = false;
      throw new Error("Execution context was destroyed");
    }
    return read(fn);
  };
  assert.equal((await loadAaFlights(p, searchFor(), { now: p.now })).rows.length, 5);
  p.evaluate = async () => {
    throw new Error("unexpected exception");
  };
  await assert.rejects(loadAaFlights(p, searchFor(), { now: p.now }), /unexpected exception/);
});
