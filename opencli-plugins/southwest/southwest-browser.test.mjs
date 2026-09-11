import assert from "node:assert/strict";
import test from "node:test";
import { loadSouthwestFlights, SouthwestLoginRequiredError } from "./southwest-browser.mjs";
import { fixture, mockPage, searchFor } from "./test-fixtures.mjs";

test("navigates afresh and waits for complete stable results without clicking anything", async () => {
  const d = fixture();
  const p = mockPage([{ ...d, ready: false, loading: true, rows: [] }, d, d]);
  assert.equal((await loadSouthwestFlights(p, searchFor(), { now: p.now })).rows.length, 4);
  assert.equal(p.urls[0], "about:blank");
  assert.match(p.urls[1], /fareType=POINTS/);
  assert.equal(p.now(), 2000);
});
test("remembers the largest observed count and waits through partial renders", async () => {
  const d = fixture();
  const p = mockPage([
    { ...d, rows: d.rows.slice(0, 1) },
    { ...d, expected_count: 1, rows: d.rows.slice(0, 1) },
    d,
    d,
  ]);
  assert.equal((await loadSouthwestFlights(p, searchFor(), { now: p.now })).rows.length, 4);
  assert.equal(p.now(), 3000);
});
test("loading resets stability and changing fares must settle", async () => {
  const d = fixture();
  const changed = fixture();
  changed.rows[0].fares[0].amount_text = "14,000 Points";
  const p = mockPage([d, { ...d, loading: true }, d, changed, changed]);
  const result = await loadSouthwestFlights(p, searchFor(), { now: p.now });
  assert.equal(result.rows[0].fares[0].amount_text, "14,000 Points");
  assert.equal(p.now(), 4000);
});
test("timeouts never return partial results", async () => {
  const d = fixture();
  const p = mockPage([{ ...d, rows: d.rows.slice(0, 1) }]);
  await assert.rejects(
    loadSouthwestFlights(p, searchFor("points", { timeout: 5 }), { now: p.now }),
    /No partial prices/,
  );
});
test("confirmed empty results still need two stable reads", async () => {
  const d = { ...fixture(), rows: [], expected_count: 0, no_results: true };
  const p = mockPage([d]);
  assert.equal((await loadSouthwestFlights(p, searchFor(), { now: p.now })).rows.length, 0);
  assert.equal(p.now(), 1000);
});
for (const [flag, value, pattern] of [
  ["challenge", true, /access challenge/],
  ["error", "Invalid airport code", /Invalid airport code/],
  ["price_mode", "usd", /cash\/points mode/],
  ["route_text", "SFOHOU", /displayed route/],
])
  test(`fails explicitly for ${flag}`, async () => {
    const p = mockPage([{ ...fixture(), [flag]: value }]);
    await assert.rejects(loadSouthwestFlights(p, searchFor(), { now: p.now }), pattern);
  });
test("login walls remain typed and do not substitute cash prices", async () => {
  const p = mockPage([{ ...fixture(), login_required: true }]);
  await assert.rejects(
    loadSouthwestFlights(p, searchFor(), { now: p.now }),
    SouthwestLoginRequiredError,
  );
});

test("does not forget a larger count observed while loading", async () => {
  const d = fixture();
  const p = mockPage([
    { ...d, loading: true },
    { ...d, expected_count: 1, rows: d.rows.slice(0, 1) },
  ]);
  await assert.rejects(
    loadSouthwestFlights(p, searchFor("points", { timeout: 5 }), { now: p.now }),
    /No partial prices/,
  );
});

test("reports a provider validation redirect without waiting for the results deadline", async () => {
  const p = mockPage([
    { ...fixture(), ready: false, url: "https://www.southwest.com/air/booking/?validate=true" },
  ]);
  await assert.rejects(
    loadSouthwestFlights(p, searchFor(), { now: p.now }),
    /rejected these search conditions/,
  );
  assert.equal(p.now(), 0);
});
