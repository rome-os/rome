import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { loadSouthwestFlights } from "./southwest-browser.mjs";
import { readSouthwestPage } from "./southwest-page.mjs";
import { normalizeResults } from "./southwest-helpers.mjs";
import { fixture, mockPage, searchFor } from "./test-fixtures.mjs";

// The web test workspace owns jsdom. Southwest has no runtime dependencies.
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);
function makeDom(mode = "points", empty = false) {
  const data = fixture(mode);
  const markup = empty ? "empty" : mode;
  const dom = new JSDOM(
    readFileSync(new URL(`./fixtures/${markup}.html`, import.meta.url), "utf8"),
    {
      url: data.url,
      runScripts: "outside-only",
    },
  );
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
    throw new Error("Unrelated account data must not be accessed");
  };
  const guarded = (props) => {
    Object.defineProperty(props, "accountState", { get: poison, enumerable: true });
    return props;
  };
  function attach(e, props) {
    e.__reactFiber$fixture = {
      memoizedProps: { children: [] },
      return: { memoizedProps: guarded(props) },
    };
  }
  const matrix = w.document.querySelector(".air-booking-select-price-matrix");
  attach(matrix, {
    searchQuery: guarded({ ...data.search }),
    ...(empty
      ? JSON.parse(readFileSync(new URL("./fixtures/empty-matrix.json", import.meta.url), "utf8"))
      : {
          details: data.rows.map(() => ({})),
          availableFlights: data.available_count,
          loading: false,
          hasNoFlightsAvailableError: false,
        }),
  });
  if (empty && mode === "cash") {
    matrix
      .querySelector('[data-test="currency-options-toggle-item--points"]')
      .classList.remove("swa-g-selected");
    matrix
      .querySelector('[data-test="currency-options-toggle-item--usd"]')
      .classList.add("swa-g-selected");
  }
  for (const [i, e] of [...w.document.querySelectorAll(".air-booking-select-detail")].entries()) {
    const r = data.rows[i];
    attach(e, {
      originationAirportCode: r.origin,
      destinationAirportCode: r.destination,
      departureDateTime: r.departure_at,
      arrivalDateTime: r.arrival_at,
      totalDuration: r.duration_minutes,
      flightNumbers: r.flight_numbers,
      stopsDetails: r.segments.map((s) =>
        guarded({
          originationAirportCode: s.origin,
          destinationAirportCode: s.destination,
          departureDateTime: s.departure_at,
          arrivalDateTime: s.arrival_at,
          flightNumber: s.flight_number,
          changePlanes: s.change_planes,
          stopDuration: s.stop_minutes,
          legDuration: s.duration_minutes,
          operatingCarrierCode: s.operating_carrier,
          marketingCarrierCode: s.marketing_carrier,
        }),
      ),
    });
  }
  // Southwest encodes this calendar attribute as midnight in the browser's timezone.
  w.document
    .querySelector('[aria-current="true"]')
    .setAttribute("itemday", String(new Date(2026, 10, 13).getTime()));
  return dom;
}
const read = (dom) =>
  JSON.parse(JSON.stringify(dom.window.eval(`(${readSouthwestPage.toString()})()`)));
for (const mode of ["points", "cash"])
  test(`returns confirmed empty ${mode} results without a details prop after two DOM reads`, async () => {
    const dom = makeDom(mode, true);
    try {
      const props = dom.window.document.querySelector(".air-booking-select-price-matrix")
        .__reactFiber$fixture.return.memoizedProps;
      assert.equal(Object.hasOwn(props, "details"), false);
      const data = read(dom);
      assert.equal(data.ready, true);
      assert.equal(data.loading, false);
      assert.equal(data.expected_count, 0);
      assert.equal(data.no_results, true);
      const page = { ...mockPage([]), evaluate: async () => read(dom) };
      const search = searchFor(mode);
      const result = await loadSouthwestFlights(page, search, { now: page.now });
      assert.deepEqual(normalizeResults(result, search), []);
      assert.equal(page.now(), 1000);
    } finally {
      dom.window.close();
    }
  });
test("accepts confirmed empty matrices that supply an empty details array", () => {
  const dom = makeDom("points", true);
  try {
    const props = dom.window.document.querySelector(".air-booking-select-price-matrix")
      .__reactFiber$fixture.return.memoizedProps;
    props.details = [];
    props.totalResults = 1;
    assert.deepEqual(normalizeResults(read(dom), searchFor()), []);
  } finally {
    dom.window.close();
  }
});
for (const [name, overrides] of [
  ["still loading", { loading: true }],
  ["missing empty-state confirmation", { hasNoFlightsAvailableError: undefined }],
  ["available flights", { availableFlights: 1 }],
  ["nonzero total results", { totalResults: 1 }],
  ["missing total results", { totalResults: undefined }],
  ["malformed details", { details: {} }],
  ["unrendered flight details", { details: [{}] }],
])
  test(`does not return empty results when the matrix has ${name}`, async () => {
    const dom = makeDom("points", true);
    try {
      const props = dom.window.document.querySelector(".air-booking-select-price-matrix")
        .__reactFiber$fixture.return.memoizedProps;
      Object.assign(props, overrides);
      assert.equal(read(dom).no_results, false);
      const page = { ...mockPage([]), evaluate: async () => read(dom) };
      await assert.rejects(
        loadSouthwestFlights(page, searchFor("points", { timeout: 5 }), { now: page.now }),
        /No partial prices/,
      );
    } finally {
      dom.window.close();
    }
  });
test("does not reuse an empty count after the DOM loses empty-state confirmation", async () => {
  const dom = makeDom("points", true);
  try {
    const props = dom.window.document.querySelector(".air-booking-select-price-matrix")
      .__reactFiber$fixture.return.memoizedProps;
    const page = {
      ...mockPage([]),
      evaluate: async () => {
        const data = read(dom);
        props.totalResults = 1;
        return data;
      },
    };
    await assert.rejects(
      loadSouthwestFlights(page, searchFor("points", { timeout: 5 }), { now: page.now }),
      /No partial prices/,
    );
  } finally {
    dom.window.close();
  }
});
for (const mode of ["points", "cash"])
  test(`reads captured ${mode} markup using self-contained browser code and allowlisted props`, () => {
    const dom = makeDom(mode);
    try {
      const data = read(dom);
      assert.equal(data.ready, true);
      assert.equal(data.loading, false);
      assert.equal(data.expected_count, 4);
      assert.equal(data.rows.length, 4);
      assert.equal(data.selected_date, "2026-11-13");
      assert.equal(data.search.accountState, undefined);
      assert.equal(data.rows[0].accountState, undefined);
      assert.equal(data.rows[0].segments[0].accountState, undefined);
      assert.deepEqual(data.rows, fixture(mode).rows);
      const rows = normalizeResults(data, searchFor(mode));
      assert.equal(rows.length, 15);
      assert.equal(rows[0].price, mode === "cash" ? 200 : null);
      assert.equal(rows[0].points, mode === "points" ? 13500 : null);
      assert.equal(rows[0].cash_price_rounded_up, mode === "cash");
    } finally {
      dom.window.close();
    }
  });
test("ignores hidden responsive duplicates without excluding offscreen flights", () => {
  const dom = makeDom();
  try {
    const d = dom.window.document;
    const row = d.querySelector(".air-booking-select-detail");
    for (const attrs of [
      "hidden",
      'aria-hidden="true"',
      'style="display:none"',
      'style="visibility:hidden"',
    ]) {
      const wrapper = d.createElement("div");
      wrapper.innerHTML = `<div ${attrs}>${row.outerHTML}</div>`;
      row.parentElement.append(wrapper);
    }
    const offscreen = row.cloneNode(true);
    offscreen.style.cssText = "position:absolute;top:5000px";
    row.parentElement.append(offscreen);
    assert.equal(read(dom).rows.length, 5);
  } finally {
    dom.window.close();
  }
});
test("does not return a mobile-selected subset of fare products", () => {
  const dom = makeDom();
  try {
    dom.window.document.querySelector('[data-test="fare-button--choice"]').style.display = "none";
    assert.throws(() => normalizeResults(read(dom), searchFor()), /all four fare products/);
  } finally {
    dom.window.close();
  }
});
test("ignores unavailable fare amounts even if hidden stale numeric nodes remain", () => {
  const dom = makeDom();
  try {
    const f = dom.window.document.querySelector('[data-test="fare-button--basic"]');
    f.classList.add("fare-button_disabled");
    f.querySelector("button").disabled = true;
    assert.equal(normalizeResults(read(dom), searchFor())[0].fare_product, "choice");
  } finally {
    dom.window.close();
  }
});
test("rejects missing component data instead of inferring wrong redeye arrival dates", () => {
  const dom = makeDom();
  try {
    const row = dom.window.document.querySelectorAll(".air-booking-select-detail")[3];
    delete row.__reactFiber$fixture;
    const data = read(dom);
    assert.equal(data.rows[3].arrival_at, null);
    assert.throws(() => normalizeResults(data, searchFor()), /timestamp/);
  } finally {
    dom.window.close();
  }
});
test("reports absent matrix state as not ready", () => {
  const dom = makeDom();
  try {
    delete dom.window.document.querySelector(".air-booking-select-price-matrix")
      .__reactFiber$fixture;
    assert.equal(read(dom).ready, false);
  } finally {
    dom.window.close();
  }
});
test("rejects stale fare mode and missing taxes in the actual DOM", () => {
  const dom = makeDom();
  try {
    const d = dom.window.document;
    d.querySelector('[data-test="currency-options-toggle-item--points"]').classList.remove(
      "swa-g-selected",
    );
    d.querySelector('[data-test="currency-options-toggle-item--usd"]').classList.add(
      "swa-g-selected",
    );
    assert.throws(() => normalizeResults(read(dom), searchFor()), /cash\/points mode/);
    d.querySelector('[data-test="currency-options-toggle-item--usd"]').classList.remove(
      "swa-g-selected",
    );
    d.querySelector('[data-test="currency-options-toggle-item--points"]').classList.add(
      "swa-g-selected",
    );
    d.querySelector(".taxes-text").remove();
    assert.throws(() => normalizeResults(read(dom), searchFor()), /unreadable fare/);
  } finally {
    dom.window.close();
  }
});
test("login prompts in the header and earned-points copy are not award walls", () => {
  const dom = makeDom("cash");
  try {
    const d = dom.window.document;
    d.body.insertAdjacentHTML("afterbegin", "<header>Log in to view points balance</header>");
    assert.equal(read(dom).login_required, false);
    d.body.insertAdjacentHTML(
      "afterbegin",
      '<div class="page-error">Log in to view points fares</div>',
    );
    assert.equal(read(dom).login_required, true);
  } finally {
    dom.window.close();
  }
});
test("detects a provider challenge rather than returning existing stale results", () => {
  const dom = makeDom();
  try {
    dom.window.document.title = "Access Denied";
    assert.equal(read(dom).challenge, true);
  } finally {
    dom.window.close();
  }
});
