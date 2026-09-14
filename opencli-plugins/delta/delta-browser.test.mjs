import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DeltaLoginRequiredError, loadDeltaFlights } from "./delta-browser.mjs";
import { normalizeSearch } from "./delta-helpers.mjs";
import { DELTA_HOME } from "./delta-form.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/miles.json", import.meta.url)));
const search = normalizeSearch({
  from: "SFO",
  to: "JFK",
  depart: "2026-11-13",
  adults: 2,
  miles: true,
  timeout: 10,
});
function browser(states) {
  let i = 0,
    time = 0;
  const calls = [];
  const queue = states;
  const page = {
    async goto(url) {
      assert.match(url, /^https?:\/\//, "Browser Bridge only permits HTTP(S) navigation");
      calls.push(["goto", url]);
    },
    async evaluate(fn) {
      const name = typeof fn === "string" ? "prepareSearchForm" : fn.name;
      calls.push(["evaluate", name]);
      if (name !== "readDeltaPage") return true;
      return structuredClone(queue[Math.min(i++, queue.length - 1)]);
    },
    async selectTab(index) {
      assert.equal(index, 0);
    },
    async wait() {
      time += 1000;
    },
  };
  return {
    page,
    calls,
    options: { now: () => time, submit: async () => calls.push(["submit", "homepage"]) },
  };
}

test("prepares and submits separately, expands every page, and waits for stable complete results", async () => {
  const data = fixture();
  const b = browser([
    { ...data, rows: [], loading: true },
    { ...data, rows: data.rows.slice(0, 1), more: true },
    { ...data, rows: data.rows.slice(0, 3), more: true },
    data,
    data,
  ]);
  assert.deepEqual(await loadDeltaFlights(b.page, search, b.options), data);
  assert.deepEqual(
    b.calls.filter(([method]) => method === "goto"),
    [["goto", DELTA_HOME]],
  );
  assert.equal(b.calls.filter((c) => c[1] === "expandMoreFlights").length, 2);
  assert.deepEqual(b.calls[1], ["submit", "homepage"]);
});

test("keeps the highest total when counters vanish or shrink during expansion", async () => {
  const data = fixture();
  const partial = { ...data, rows: data.rows.slice(0, 1) };
  for (const total of [null, 1]) {
    const b = browser([{ ...partial, more: true }, { ...partial, total }, data, data]);
    assert.equal((await loadDeltaFlights(b.page, search, b.options)).rows.length, 4);
    const stuck = browser([
      { ...partial, more: true },
      { ...partial, total },
    ]);
    await assert.rejects(loadDeltaFlights(stuck.page, search, stuck.options), /No partial prices/);
  }
});

for (const [name, patch] of Object.entries({
  loading: { loading: true },
  missing: { rows: [] },
  unknownTotal: { total: null },
  stuckButton: { more: true },
  droppedRows: { total: 100 },
  vanishingResults: { rows: [], no_results: true, total: 4 },
}))
  test(`incomplete results cannot become empty success: ${name}`, async () => {
    const b = browser([{ ...fixture(), ...patch }]);
    await assert.rejects(loadDeltaFlights(b.page, search, b.options), /No partial prices/);
    assert.ok(b.calls.filter((c) => c[1] === "expandMoreFlights").length <= 1);
  });

test("explicit no-results is distinct from missing/unloaded results", async () => {
  const data = { ...fixture(), rows: [], no_results: true, total: 0, date_heading: "" };
  const b = browser([data]);
  assert.deepEqual(await loadDeltaFlights(b.page, search, b.options), data);
});

for (const [flag, error] of [
  ["challenge", /access challenge/],
  ["service_error", /Retry later/],
  ["login_required", DeltaLoginRequiredError],
])
  test(`${flag} fails immediately, without a cash fallback or access bypass`, async () => {
    const b = browser([{ ...fixture(), [flag]: true }]);
    await assert.rejects(loadDeltaFlights(b.page, search, b.options), error);
    assert.equal(b.calls.filter((c) => c[1] === "readDeltaPage").length, 1);
    assert.equal(
      b.calls.some((c) => c[1] === "submitSearchForm"),
      false,
    );
  });

test("wrong mode and stale route fail closed", async () => {
  for (const patch of [{ price_mode: "$USD" }, { route_text: "SFO IAH" }]) {
    const b = browser([{ ...fixture(), ...patch }]);
    await assert.rejects(loadDeltaFlights(b.page, search, b.options), /mode|requested/);
  }
});

test("submission must finish before results are read", async () => {
  const b = browser([fixture()]);
  b.page.evaluate = async () => assert.fail("must not read old results");
  await assert.rejects(
    loadDeltaFlights(b.page, search, {
      ...b.options,
      submit: async () => {
        throw new Error("form blocked");
      },
    }),
    /form blocked/,
  );
});
