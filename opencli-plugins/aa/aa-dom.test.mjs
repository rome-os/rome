import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { readAaPage } from "./aa-page.mjs";
import { normalizeResults } from "./aa-helpers.mjs";
import { fixture, searchFor } from "./test-fixtures.mjs";

// The web test workspace owns jsdom. AA has no runtime dependencies.
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);
function makeDom(mode = "cash") {
  const dom = new JSDOM(readFileSync(new URL(`./fixtures/${mode}.html`, import.meta.url), "utf8"), {
    url: "https://www.aa.com/booking/choose-flights/1",
    runScripts: "outside-only",
  });
  const { window: w } = dom;
  w.HTMLElement.prototype.getClientRects = function () {
    for (let e = this; e; e = e.parentElement)
      if (e.hidden || w.getComputedStyle(e).display === "none") return [];
    return [{}];
  };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  const poison = () => {
    throw new Error("Authentication material must not be accessed");
  };
  for (const key of ["localStorage", "sessionStorage"])
    Object.defineProperty(w, key, { get: poison });
  Object.defineProperty(w.document, "cookie", { get: poison, set: poison });
  return dom;
}
const read = (dom) => JSON.parse(JSON.stringify(dom.window.eval(`(${readAaPage.toString()})()`)));
for (const mode of ["cash", "award", "round-cash", "round-award"])
  test(`serialized page reader parses captured ${mode} DOM without auth storage`, () => {
    const d = read(makeDom(mode));
    assert.deepEqual(d, fixture(mode));
    const rows = normalizeResults(d, searchFor(mode));
    assert.equal(d.expected_count, 5);
    assert.equal(d.rows.length, 5);
    assert.equal(rows.length, { cash: 15, award: 9, "round-cash": 18, "round-award": 13 }[mode]);
    assert.equal(
      rows[0].price,
      mode.includes("award") ? null : mode.startsWith("round") ? 697 : 206,
    );
    assert.equal(
      rows[0].miles,
      mode.includes("award") ? (mode.startsWith("round") ? 45000 : 27000) : null,
    );
    assert.equal(
      rows[0].taxes,
      mode.includes("award") ? (mode.startsWith("round") ? 549.03 : 5.6) : null,
    );
  });
test("ignores hidden responsive duplicates, hidden fare buttons and calendar prices", () => {
  const dom = makeDom();
  const d = dom.window.document;
  const row = d.querySelector("app-slice-details");
  const clone = row.cloneNode(true);
  clone.hidden = true;
  row.after(clone);
  const fare = row.querySelector("button.btn-flight");
  const hidden = fare.cloneNode(true);
  hidden.style.display = "none";
  fare.after(hidden);
  d.body.insertAdjacentHTML(
    "afterbegin",
    '<div class="calendar"><span class="per-pax-amount">$1</span></div>',
  );
  assert.equal(normalizeResults(read(dom), searchFor()).length, 15);
});
test("reads actual current amount rather than a hidden crossed-out amount", () => {
  const dom = makeDom();
  dom.window.document
    .querySelector("button.btn-flight .price")
    .insertAdjacentHTML("afterbegin", '<span class="per-pax-amount" hidden>$1</span>');
  assert.equal(normalizeResults(read(dom), searchFor())[0].price, 206);
});
test("disabled fare buttons cannot create zero-mile awards", () => {
  const dom = makeDom("award");
  const d = dom.window.document;
  const b = d.querySelector("button.btn-flight").cloneNode(true);
  b.disabled = true;
  b.querySelector(".per-pax-amount").textContent = "0K";
  d.querySelector(".products-row").append(b);
  assert.equal(normalizeResults(read(dom), searchFor("award")).length, 9);
});
test("changed search checkbox never silently turns awards into cash", () => {
  const dom = makeDom("award");
  dom.window.document.querySelector("#redeem-miles").checked = false;
  assert.throws(() => normalizeResults(read(dom), searchFor("award")), /miles/);
});
test("finds a visible loading indicator and error notification", () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML(
    "afterbegin",
    '<div role="progressbar"></div><app-error-notification>Search failed</app-error-notification>',
  );
  const d = read(dom);
  assert.equal(d.loading, true);
  assert.equal(d.error, "Search failed");
});
test("detects access blocks and expired sessions", () => {
  const dom = makeDom();
  dom.window.document.body.textContent = "Access Denied";
  assert.equal(read(dom).challenge, true);
  dom.window.document.body.textContent = "Your session expired";
  assert.equal(read(dom).expired, true);
});
test("safely reads the transient empty document during navigation", () => {
  const dom = makeDom();
  dom.window.document.documentElement.remove();
  const data = read(dom);
  assert.equal(data.ready, false);
  assert.equal(data.language, "");
});
test("missing fields and changed locale fail closed", () => {
  const dom = makeDom();
  dom.window.document.querySelector(".duration").remove();
  assert.throws(() => normalizeResults(read(dom), searchFor()), /No partial/);
  const other = makeDom();
  other.window.document.documentElement.lang = "es";
  assert.throws(() => normalizeResults(read(other), searchFor()), /English/);
});

test("award names survive delayed analytics data-product attributes", () => {
  const dom = makeDom("award");
  dom.window.document
    .querySelectorAll("[data-product]")
    .forEach((e) => e.removeAttribute("data-product"));
  const rows = normalizeResults(read(dom), searchFor("award"));
  assert.equal(rows[0].fare_product, "Main");
  assert.equal(rows[1].fare_product, "First");
});

test("preserves award overnight and extended-layover notices", () => {
  const rows = normalizeResults(read(makeDom("award")), searchFor("award"));
  assert.ok(rows.some((r) => r.alerts.includes("Extended layover")));
  const round = normalizeResults(read(makeDom("round-award")), searchFor("round-award"));
  assert.ok(round.some((r) => r.alerts.includes("Overnight travel")));
});
