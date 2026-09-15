import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { readDeltaForm, submitDeltaSearch, DeltaLoginRequiredError } from "./delta-form.mjs";
import { normalizeSearch } from "./delta-helpers.mjs";
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);
const search = (extra) =>
  normalizeSearch({ from: "SFO", to: "IAH", depart: "2026-09-29", timeout: 10, ...extra });

function browser(
  t,
  {
    month = "2026-09",
    duplicates = false,
    unavailable = null,
    noSuggestions = false,
    ignoreDone = false,
  } = {},
) {
  const dom = new JSDOM(
    `<main>
    <button aria-label="Origin, Origin">LAX Origin</button><button aria-label="Destination, Destination">JFK Destination</button>
    <button aria-label="Trip Type, Round Trip" aria-expanded="false"></button>
    <button aria-label="Passenger Count, 3" aria-expanded="false"></button>
    <button aria-label="Flight Date Field, DepartDate Nov 13 - ReturnDate Nov 20"></button>
    <input id="shopWithMiles" type="checkbox" checked><input id="flexibleDate" type="checkbox" checked>
    <input id="basicFaresField" type="checkbox"><input id="showExtraFareOnly" type="checkbox" checked>
    <button id="findFilghtsCta">Find Flights</button>
    <div id="options" hidden></div><div id="airports" hidden><input id="predictive_search_test"><ul role="listbox" aria-label="predictive_search_list"></ul></div>
    <div role="dialog" aria-label="Choose Dates" hidden><button class="date-picker__footer-clear-button">Clear</button>
      <button aria-label="Previous month"></button><div id="days"></div><button aria-label="Next month"></button>
      <button aria-label="Date Picker Test Done Button">Done</button></div>
    </main>`,
    { runScripts: "outside-only", url: "https://www.delta.com/" },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    d = w.document;
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
  const main = d.querySelector("main"),
    get = (sel) => main.querySelector(sel.startsWith("#") ? `[id="${sel.slice(1)}"]` : sel);
  const origin = get('[aria-label^="Origin,"]'),
    destination = get('[aria-label^="Destination,"]');
  const trip = get('[aria-label^="Trip Type,"]'),
    passengers = get('[aria-label^="Passenger Count,"]');
  const trigger = get('[aria-label^="Flight Date Field"]'),
    calendar = get('[role="dialog"]');
  let time = 0,
    airport,
    selected = [],
    submitted = null;
  const calls = [],
    dateClicks = [];
  const label = (date) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const render = () => {
    const days = get("#days");
    days.replaceChildren();
    const [year, mon] = month.split("-").map(Number),
      count = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    for (let n = 1; n <= count; n++) {
      const iso = `${month}-${String(n).padStart(2, "0")}`;
      const b = d.createElement("button");
      b.dataset.dateValue = `${mon}-${n}-${year}`;
      b.textContent = String(n);
      b.disabled = iso === unavailable;
      b.classList.toggle("selected", selected.includes(iso));
      b.addEventListener("click", () => {
        dateClicks.push({ date: iso, time });
        if (trip.getAttribute("aria-label").endsWith("One Way")) selected = [];
        selected.push(iso);
        render();
      });
      if (duplicates) {
        const hidden = b.cloneNode(true);
        hidden.dataset.hidden = "true";
        hidden.dataset.outside = "true";
        hidden.style.visibility = "hidden";
        days.append(hidden);
      }
      days.append(b);
    }
  };
  for (const [button, kind] of [
    [trip, "trip"],
    [passengers, "passengers"],
  ])
    button.addEventListener("click", () => {
      const options = get("#options");
      options.replaceChildren();
      options.hidden = false;
      button.setAttribute("aria-expanded", "true");
      const values = kind === "trip" ? ["ROUND_TRIP", "ONE_WAY"] : ["1", "2", "3", "9"];
      for (const value of values) {
        const li = d.createElement("li");
        li.setAttribute("role", "option");
        li.dataset.value = value;
        li.textContent = value;
        li.addEventListener("click", () => {
          button.setAttribute(
            "aria-label",
            kind === "trip"
              ? `Trip Type, ${value === "ONE_WAY" ? "One Way" : "Round Trip"}`
              : `Passenger Count, ${value}`,
          );
          options.hidden = true;
          button.setAttribute("aria-expanded", "false");
        });
        options.append(li);
      }
    });
  for (const button of [origin, destination])
    button.addEventListener("click", () => {
      airport = button;
      get("#airports").hidden = false;
    });
  trigger.addEventListener("click", () => {
    calendar.hidden = false;
    render();
  });
  get(".date-picker__footer-clear-button").addEventListener("click", () => {
    selected = [];
    render();
  });
  for (const direction of ["Previous", "Next"])
    get(`[aria-label="${direction} month"]`).addEventListener("click", () => {
      const next = new Date(`${month}-01T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + (direction === "Next" ? 1 : -1));
      month = next.toISOString().slice(0, 7);
      render();
    });
  get('[aria-label$="Done Button"]').addEventListener("click", () => {
    if (ignoreDone) return;
    trigger.setAttribute(
      "aria-label",
      `Flight Date Field, DepartDate ${label(selected[0])}${trip.getAttribute("aria-label").endsWith("Round Trip") ? ` - ReturnDate ${label(selected[1])}` : ""}`,
    );
    calendar.hidden = true;
  });
  get("#findFilghtsCta").addEventListener("click", () => {
    assert.ok(calendar.hidden && get("#airports").hidden && get("#options").hidden);
    submitted = {
      origin: origin.textContent,
      destination: destination.textContent,
      trip: trip.getAttribute("aria-label"),
      adults: passengers.getAttribute("aria-label"),
      dates: [...selected],
      miles: get("#shopWithMiles").checked,
      flexible: get("#flexibleDate").checked,
      basic: get("#basicFaresField").checked,
      refundable: get("#showExtraFareOnly").checked,
    };
  });
  if (duplicates) {
    for (const type of ["hidden", "aria", "visibility"]) {
      const copy = main.cloneNode(true);
      if (type === "hidden") copy.hidden = true;
      else if (type === "aria") copy.setAttribute("aria-hidden", "true");
      else copy.style.visibility = "hidden";
      main.before(copy);
    }
  }
  const page = {
    async evaluate(fn) {
      assert.equal(fn, readDeltaForm);
      return JSON.parse(JSON.stringify(w.eval(`(${fn.toString()})()`)));
    },
    async click(selector, { nth } = {}) {
      const all = [...d.querySelectorAll(selector)];
      assert.ok(nth !== undefined || all.length === 1, "ambiguous selector");
      const e = all[nth ?? 0];
      assert.ok(e && e.getClientRects().length && !e.closest('[hidden],[aria-hidden="true"]'));
      assert.notEqual(w.getComputedStyle(e).visibility, "hidden");
      assert.ok(!e.disabled);
      calls.push(selector);
      e.click();
    },
    async fillText(selector, value, { nth } = {}) {
      const e = d.querySelectorAll(selector)[nth ?? 0];
      e.value = value;
      const list = get('[role="listbox"]');
      list.replaceChildren();
      if (noSuggestions) return;
      for (const code of ["ALL", value]) {
        const li = d.createElement("li");
        li.setAttribute("role", "option");
        li.title = code;
        li.textContent = code;
        li.addEventListener("click", () => {
          assert.equal(code, value);
          airport.textContent = `${code} Airport`;
          get("#airports").hidden = true;
        });
        list.append(li);
      }
    },
    async wait({ time: seconds }) {
      time += seconds * 1000;
    },
  };
  return { page, document: d, get, now: () => time, calls, dateClicks, submitted: () => submitted };
}

for (const miles of [false, true])
  for (const round of [false, true])
    test(`submits homepage ${miles ? "miles" : "cash"} ${round ? "round trip" : "one way"} with hidden duplicates`, async (t) => {
      const b = browser(t, { duplicates: true, month: "2026-10" });
      await submitDeltaSearch(
        b.page,
        search({ miles, adults: 2, ...(round ? { return: "2026-10-02" } : {}) }),
        { now: b.now },
      );
      assert.deepEqual(b.submitted(), {
        origin: "SFO Airport",
        destination: "IAH Airport",
        trip: `Trip Type, ${round ? "Round Trip" : "One Way"}`,
        adults: "Passenger Count, 2",
        dates: round ? ["2026-09-29", "2026-10-02"] : ["2026-09-29"],
        miles,
        flexible: false,
        basic: true,
        refundable: false,
      });
      assert.ok(b.dateClicks[0].time >= 1000, "calendar must settle before clicking");
    });

test("selects dates across a year boundary and nine passengers", async (t) => {
  const b = browser(t, { month: "2027-02" });
  await submitDeltaSearch(
    b.page,
    search({ depart: "2026-12-31", return: "2027-01-02", adults: 9 }),
    { now: b.now },
  );
  assert.deepEqual(b.submitted().dates, ["2026-12-31", "2027-01-02"]);
});
test("selects a same-day return separately", async (t) => {
  const b = browser(t);
  await submitDeltaSearch(b.page, search({ return: "2026-09-29" }), { now: b.now });
  assert.deepEqual(b.submitted().dates, ["2026-09-29", "2026-09-29"]);
});
for (const options of [
  { unavailable: "2026-09-29" },
  { noSuggestions: true },
  { ignoreDone: true },
])
  test(`does not submit when form interaction fails: ${JSON.stringify(options)}`, async (t) => {
    const b = browser(t, options);
    await assert.rejects(
      submitDeltaSearch(b.page, search({ timeout: 5 }), { now: b.now }),
      /does not offer|suggest airport|close the calendar/,
    );
    assert.equal(b.submitted(), null);
  });
test("disabled toggles are accepted only when already correct", async (t) => {
  const b = browser(t);
  const c = b.get("#flexibleDate");
  c.checked = false;
  c.disabled = true;
  await submitDeltaSearch(b.page, search(), { now: b.now });
  assert.ok(b.submitted());
  const other = browser(t);
  other.get("#flexibleDate").disabled = true;
  await assert.rejects(submitDeltaSearch(other.page, search(), { now: other.now }), /unavailable/);
  assert.equal(other.submitted(), null);
});
for (const [html, error] of [
  ["<h1>Access Denied</h1>", /access challenge/],
  ['<div role="alert">Unable to complete. Try again later</div>', /Retry later/],
  ['<div role="dialog">Sign in to SkyMiles</div>', DeltaLoginRequiredError],
])
  test(`fails closed for ${html}`, async (t) => {
    const b = browser(t);
    b.document.body.insertAdjacentHTML("beforeend", html);
    await assert.rejects(submitDeltaSearch(b.page, search(), { now: b.now }), error);
    assert.equal(b.calls.length, 0);
  });
test("reader excludes unrelated page and account text", async (t) => {
  const b = browser(t);
  b.document.body.insertAdjacentHTML("beforeend", "<aside>Private saved traveler</aside>");
  assert.ok(
    !JSON.stringify(await b.page.evaluate(readDeltaForm)).includes("Private saved traveler"),
  );
});
test("rejects an unsupported remembered cabin", async (t) => {
  const b = browser(t);
  b.document.body.insertAdjacentHTML(
    "beforeend",
    '<button aria-label="Best Fares For, Delta One"></button>',
  );
  await assert.rejects(submitDeltaSearch(b.page, search(), { now: b.now }), /Delta Main/);
  assert.equal(b.submitted(), null);
});

test("missing homepage controls time out without submitting", async (t) => {
  const b = browser(t);
  b.document.querySelector("main").remove();
  await assert.rejects(
    submitDeltaSearch(b.page, search({ timeout: 5 }), { now: b.now }),
    /become ready/,
  );
  assert.equal(b.calls.length, 0);
});
test("rejects dates or search settings changed while applying the calendar", async (t) => {
  for (const alter of [
    (b) =>
      b
        .get('[aria-label^="Flight Date Field"]')
        .setAttribute("aria-label", "Flight Date Field, DepartDate Sep 30"),
    (b) => {
      b.get("#shopWithMiles").checked = true;
    },
  ]) {
    const b = browser(t);
    b.get('[aria-label$="Done Button"]').addEventListener("click", () => alter(b));
    await assert.rejects(
      submitDeltaSearch(b.page, search(), { now: b.now }),
      /apply the requested dates|changed the requested/,
    );
    assert.equal(b.submitted(), null);
  }
});
test("acknowledges only the visible informational privacy notice", async (t) => {
  const b = browser(t);
  b.document.body.insertAdjacentHTML(
    "beforeend",
    '<div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler">I understand</button></div>',
  );
  const notice = b.document.querySelector("#onetrust-banner-sdk");
  notice.querySelector("button").addEventListener("click", () => (notice.hidden = true));
  await submitDeltaSearch(b.page, search(), { now: b.now });
  assert.ok(notice.hidden);
  assert.ok(b.submitted());
});
