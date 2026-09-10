import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadUnitedFlights, UnitedLoginRequiredError } from "./united-browser.mjs";
import { buildSearchUrl, normalizeSearch } from "./united-helpers.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/miles.json", import.meta.url)));
const search = normalizeSearch({
  from: "SFO",
  to: "IAH",
  depart: "2026-11-13",
  return: "2026-11-15",
  miles: true,
  timeout: 5,
});
function browser(states) {
  let index = 0;
  let time = 0;
  const calls = [];
  const page = {
    async goto(url) {
      calls.push(["goto", url]);
    },
    async evaluate(fn) {
      calls.push(["evaluate", fn.name]);
      if (fn.name === "expandAllFlights") return true;
      return structuredClone(states[Math.min(index++, states.length - 1)]);
    },
    async wait() {
      time += 1000;
    },
  };
  return { page, calls, options: { now: () => time } };
}

test("waits for loading, expands all flights, and requires stable complete results", async () => {
  const data = fixture();
  const pending = { ...data, rows: [], loading: true };
  const partial = {
    ...data,
    rows: data.rows.slice(0, 2),
    show_all: true,
    displayed: [2, data.rows.length],
  };
  const b = browser([pending, partial, data, data]);
  assert.deepEqual(await loadUnitedFlights(b.page, search, b.options), data);
  assert.deepEqual(b.calls.slice(0, 2), [
    ["goto", "about:blank"],
    ["goto", buildSearchUrl(search)],
  ]);
  assert.equal(b.calls.filter((c) => c[1] === "expandAllFlights").length, 1);
});

test("login wall is a typed error, not a switch to cash", async () => {
  const b = browser([{ ...fixture(), login_required: true }]);
  await assert.rejects(loadUnitedFlights(b.page, search, b.options), UnitedLoginRequiredError);
  assert.equal(b.calls.filter((c) => c[0] === "goto").length, 2);
});

test("access challenge fails immediately without bypassing it", async () => {
  const b = browser([{ ...fixture(), challenge: true }]);
  await assert.rejects(loadUnitedFlights(b.page, search, b.options), /access challenge/);
});

test("loading forever, missing rows, and incomplete expansion are not empty success", async () => {
  for (const patch of [
    { loading: true, rows: [] },
    { rows: [] },
    { show_all: true, displayed: [35, 80] },
  ]) {
    const b = browser([{ ...fixture(), ...patch }]);
    await assert.rejects(loadUnitedFlights(b.page, search, b.options), /No partial prices/);
    assert.ok(b.calls.filter((c) => c[1] === "expandAllFlights").length <= 1);
  }
});

test("explicit no-flights response is distinct from an unloaded page", async () => {
  const data = { ...fixture(), rows: [], no_results: true, date_heading: "" };
  const b = browser([data]);
  assert.deepEqual(await loadUnitedFlights(b.page, search, b.options), data);
});

test("stale cash results cannot satisfy a miles request", async () => {
  const b = browser([{ ...fixture(), price_mode: "money" }]);
  await assert.rejects(loadUnitedFlights(b.page, search, b.options), /money\/miles mode/);
});

test("United service errors fail immediately instead of timing out or reporting no flights", async () => {
  const b = browser([{ ...fixture(), rows: [], service_error: true }]);
  await assert.rejects(loadUnitedFlights(b.page, search, b.options), /Retry later/);
  assert.equal(b.calls.filter((c) => c[1] === "readUnitedPage").length, 1);
});

test("waits through 2/5 -> 2 -> 2 -> 5 when the total disappears during expansion", async () => {
  const data = fixture();
  assert.equal(data.rows.length, 5);
  const partial = { ...data, rows: data.rows.slice(0, 2) };
  const b = browser([
    { ...partial, show_all: true, displayed: [2, 5] },
    partial,
    partial,
    data,
    data,
  ]);
  const result = await loadUnitedFlights(b.page, search, b.options);
  assert.equal(result.rows.length, 5);
  assert.equal(b.calls.filter((c) => c[1] === "readUnitedPage").length, 5);
});

test("does not accept a vanished or reduced counter while visible rows remain incomplete", async () => {
  const data = fixture();
  const partial = { ...data, rows: data.rows.slice(0, 2) };
  for (const displayed of [[], [2, 2], [5, 5]]) {
    const b = browser([
      { ...partial, show_all: true, displayed: [2, 5] },
      { ...partial, displayed },
    ]);
    await assert.rejects(loadUnitedFlights(b.page, search, b.options), /No partial prices/);
  }
});

test("retains totals observed while the result list is still loading", async () => {
  const data = fixture();
  const partial = { ...data, rows: data.rows.slice(0, 2) };
  const b = browser([{ ...partial, loading: true, displayed: [2, 5] }, partial]);
  await assert.rejects(loadUnitedFlights(b.page, search, b.options), /No partial prices/);
});

test("expansion without any total cannot return an unproven stable subset", async () => {
  const data = fixture();
  const b = browser([{ ...data, show_all: true }, data]);
  await assert.rejects(loadUnitedFlights(b.page, search, b.options), /No partial prices/);
});

test("complete counterless lists that need no expansion still succeed", async () => {
  const data = fixture();
  const b = browser([data, data]);
  assert.deepEqual(await loadUnitedFlights(b.page, search, b.options), data);
});

test("a transient no-results state cannot erase a known total", async () => {
  const data = fixture();
  const b = browser([
    { ...data, show_all: true, displayed: [2, 5] },
    { ...data, rows: [], no_results: true },
  ]);
  await assert.rejects(loadUnitedFlights(b.page, search, b.options), /No partial prices/);
});
