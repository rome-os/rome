import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { expandMoreFlights, prepareSearchForm, submitSearchForm } from "./delta-browser.mjs";
import { normalizeResults, normalizeSearch } from "./delta-helpers.mjs";
import { readDeltaPage } from "./delta-page.mjs";

// Reuse the web test workspace dependency. The plugin has no runtime dependencies.
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);
function domFor(html) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://www.delta.com/flightsearch/search-results?cacheKeySuffix=test-search",
  });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () {
    for (let e = this; e; e = e.parentElement)
      if (e.hidden || window.getComputedStyle(e).display === "none") return [];
    return [{}];
  };
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() {
      if (!this.getClientRects().length) return "";
      return this.textContent.replace(/\s+/g, " ").trim();
    },
  });
  return dom;
}
function read(dom) {
  return JSON.parse(JSON.stringify(dom.window.eval(`(${readDeltaPage.toString()})()`)));
}
function putSearch(dom, miles) {
  dom.window.localStorage.setItem(
    "postDatatest-search",
    JSON.stringify({
      tripType: "ROUND_TRIP",
      segments: [
        {
          origin: "SFO",
          destination: "IAH",
          departureDate: "2026-09-18",
          returnDate: "2026-09-25",
        },
      ],
      passengers: [{ type: "ADT", count: "1" }],
      awardTravel: String(miles),
      datesFlexible: false,
      refundableFlightsOnly: false,
      includeBasicFaresUnchecked: false,
      unrelatedField: "must not be returned",
    }),
  );
}
for (const mode of ["cash", "miles"])
  test(`reads captured Delta ${mode} DOM and excludes responsive duplicates`, () => {
    const dom = domFor(readFileSync(new URL(`./fixtures/${mode}.html`, import.meta.url), "utf8"));
    try {
      putSearch(dom, mode === "miles");
      const data = read(dom);
      assert.equal(data.rows.length, 1);
      assert.equal(data.rows[0].fares.length, 3);
      assert.deepEqual(data.rows[0].flight_numbers, ["DL1598", "DL1143"]);
      assert.deepEqual(data.rows[0].stop_labels, ["Layover at LAX, 1h 1m"]);
      assert.equal(data.rows[0].departure, "7:20 am");
      assert.equal(data.rows[0].duration_text, "5h 48m");
      assert.equal(data.total, 1);
      assert.equal(data.desktop, true);
      assert.equal(data.search.unrelatedField, undefined);
      const rows = normalizeResults(
        data,
        normalizeSearch({
          from: "SFO",
          to: "IAH",
          depart: "2026-09-18",
          return: "2026-09-25",
          miles: mode === "miles",
          cabin: "all",
        }),
      );
      assert.equal(rows.length, 3);
      assert.equal(rows[1].mixed_cabin, true);
      if (mode === "cash") assert.equal(rows[0].price, 549);
      else {
        assert.equal(rows[0].miles, 46200);
        assert.equal(rows[0].taxes, 12);
        assert.equal(rows[0].card_member_miles, 39200);
      }
    } finally {
      dom.window.close();
    }
  });

test("hidden rows and fares do not enter results, but offscreen rows do", () => {
  const dom = domFor(readFileSync(new URL("./fixtures/cash.html", import.meta.url), "utf8"));
  try {
    const d = dom.window.document;
    const row = d.querySelector('[id^="flight-results-grid-"]');
    for (const attr of [
      'style="display:none"',
      'style="visibility:hidden"',
      "hidden",
      'aria-hidden="true"',
    ]) {
      const wrapper = d.createElement("div");
      wrapper.innerHTML = `<div ${attr}>${row.outerHTML}</div>`;
      d.body.append(wrapper);
    }
    const offscreen = row.cloneNode(true);
    offscreen.id = "flight-results-grid-1";
    offscreen.style.cssText = "position:absolute;top:5000px";
    d.body.append(offscreen);
    const fare = offscreen.querySelector("idp-fare-cell-desktop").cloneNode(true);
    fare.hidden = true;
    offscreen.append(fare);
    assert.equal(read(dom).rows.length, 2);
    assert.equal(read(dom).rows[1].fares.length, 3);
  } finally {
    dom.window.close();
  }
});

test("a mobile-only layout is rejected rather than returning only its selected fare", () => {
  const dom = domFor(readFileSync(new URL("./fixtures/cash.html", import.meta.url), "utf8"));
  try {
    putSearch(dom, false);
    dom.window.document.querySelector("idp-fare-cell-desktop-row-wrapper").style.display = "none";
    const data = read(dom);
    assert.equal(data.desktop, false);
    assert.throws(
      () =>
        normalizeResults(
          data,
          normalizeSearch({ from: "SFO", to: "IAH", depart: "2026-09-18", return: "2026-09-25" }),
        ),
      /desktop-width/,
    );
  } finally {
    dom.window.close();
  }
});

test("reads cash precision, unavailable fares and next-day labels without guessing values", () => {
  const dom = domFor(readFileSync(new URL("./fixtures/cash.html", import.meta.url), "utf8"));
  try {
    putSearch(dom, false);
    const d = dom.window.document;
    const row = d.querySelector('[id^="flight-results-grid-"]');
    row.querySelector("idp-fare-cell-desktop idp-fare-cell-revenue-template").innerHTML =
      "<span>$</span><span>549.95</span>";
    const fares = row.querySelectorAll("idp-fare-cell-desktop");
    fares[1].innerHTML = "<div>Sold Out</div>";
    const line = row.querySelector('idp-mach-core-flight-card-layover[variant="detailed"]');
    line.insertAdjacentHTML(
      "beforeend",
      '<span aria-label="Confirmed: Sat, Sep 19">Sat, Sep 19</span>',
    );
    const rows = normalizeResults(
      read(dom),
      normalizeSearch({
        from: "SFO",
        to: "IAH",
        depart: "2026-09-18",
        return: "2026-09-25",
        cabin: "all",
      }),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].price, 549.95);
    assert.equal(rows[0].arrival_date, "2026-09-19");
  } finally {
    dom.window.close();
  }
});

test("reads only the search-specific storage key and projects only flight conditions", () => {
  const dom = domFor("<html><body></body></html>");
  try {
    const accessed = [];
    dom.window.Storage.prototype.getItem = function (key) {
      accessed.push(key);
      return null;
    };
    assert.equal(read(dom).search, null);
    assert.deepEqual(accessed, ["postDatatest-search"]);
    dom.window.history.replaceState({}, "", "/flightsearch/book-a-flight");
    read(dom);
    assert.equal(accessed.length, 1);
  } finally {
    dom.window.close();
  }
});

test("public form actions choose the visible duplicate IDs and only submit Find Flights", () => {
  let html =
    '<html><body><div hidden><button id="findFilghtsCta">Find Flights</button><input id="shopWithMiles" type="checkbox"></div>';
  html +=
    '<button aria-label="Origin, Origin">SFO Origin</button><button aria-label="Destination, Destination">JFK Destination</button>';
  html +=
    '<button aria-label="Trip Type, One Way"></button><button aria-label="Passenger Count, 2"></button><button aria-label="Best Fares For, Delta Main"></button>';
  for (const id of [
    "shopWithMiles",
    "flexibleDate",
    "basicFaresField",
    "showExtraFareOnly",
    "includeNearByAirport",
  ])
    html += `<input type="checkbox" id="${id}">`;
  html +=
    '<button id="findFilghtsCta">Find Flights</button><button>Select Fare</button></body></html>';
  const dom = domFor(html);
  try {
    const d = dom.window.document;
    let submitted = 0;
    const buttons = d.querySelectorAll('[id="findFilghtsCta"]');
    buttons[1].addEventListener("click", () => submitted++);
    assert.equal(read(dom).form_ready, true);
    dom.window.eval(
      `(${prepareSearchForm.toString()})(${JSON.stringify({ from: "SFO", to: "JFK", adults: 2, miles: true, returnDate: null })})`,
    );
    assert.equal(submitted, 0);
    assert.equal(d.querySelectorAll('[id="shopWithMiles"]')[0].checked, false);
    assert.equal(d.querySelectorAll('[id="shopWithMiles"]')[1].checked, true);
    assert.equal(d.getElementById("basicFaresField").checked, true);
    assert.equal(d.getElementById("flexibleDate").checked, false);
    dom.window.eval(`(${submitSearchForm.toString()})()`);
    assert.equal(submitted, 1);
  } finally {
    dom.window.close();
  }
});

test("expansion uses only a visible enabled See More Results button", () => {
  const dom = domFor(
    '<button hidden>See More Results</button><button disabled>See More Results</button><button id="more">See More Results</button><button>Select Flight</button>',
  );
  try {
    let clicked = 0;
    dom.window.document.getElementById("more").addEventListener("click", () => clicked++);
    assert.equal(dom.window.eval(`(${expandMoreFlights.toString()})()`), true);
    assert.equal(clicked, 1);
  } finally {
    dom.window.close();
  }
});

test("disabled search controls are acceptable only when their values already match", () => {
  const dom = domFor(`<button id="findFilghtsCta">Find Flights</button>
    <button aria-label="Origin, Origin">SFO Origin</button><button aria-label="Destination, Destination">JFK Destination</button>
    <button aria-label="Trip Type, One Way"></button><button aria-label="Passenger Count, 1"></button><button aria-label="Best Fares For, Delta Main"></button>
    <input type="checkbox" id="shopWithMiles" checked><input type="checkbox" id="flexibleDate" disabled>
    <input type="checkbox" id="basicFaresField" checked><input type="checkbox" id="showExtraFareOnly" disabled>
    <input type="checkbox" id="includeNearByAirport" disabled>`);
  try {
    const run = () =>
      dom.window.eval(
        `(${prepareSearchForm.toString()})(${JSON.stringify({ from: "SFO", to: "JFK", adults: 1, miles: true, returnDate: null })})`,
      );
    assert.equal(run(), true);
    dom.window.document.getElementById("flexibleDate").checked = true;
    assert.throws(run, /control is disabled/);
  } finally {
    dom.window.close();
  }
});

for (const [html, flag] of [
  ["<h1>Access Denied</h1>", "challenge"],
  ["<dialog open>Log in to SkyMiles. Password required.</dialog>", "login_required"],
  [
    '<div role="alert">We are unable to complete your request. Please try again later.</div>',
    "service_error",
  ],
  ["<idp-search-results>No flights are available</idp-search-results>", "no_results"],
  ['<div role="progressbar"></div>', "loading"],
])
  test(`detects displayed ${flag}`, () => {
    const dom = domFor(html);
    try {
      assert.equal(read(dom)[flag], true);
    } finally {
      dom.window.close();
    }
  });

test("ordinary sign-in links and hidden dialogs are not login requirements", () => {
  const dom = domFor(
    '<a>Log in to SkyMiles</a><dialog hidden role="dialog">Sign in to SkyMiles. Password</dialog>',
  );
  try {
    assert.equal(read(dom).login_required, false);
  } finally {
    dom.window.close();
  }
});

test("result counters accept singular and thousands-separated totals", () => {
  for (const [label, total] of [
    ["1 Flight Result", 1],
    ["1,234 Flight Results", 1234],
  ]) {
    const dom = domFor(`<span class="results-label">${label}</span>`);
    try {
      assert.equal(read(dom).total, total);
    } finally {
      dom.window.close();
    }
  }
});
