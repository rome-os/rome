import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { readAaForm, submitAaSearch, AaLoginRequiredError } from "./aa-form.mjs";
import { normalizeSearch } from "./aa-helpers.mjs";
const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);
const search = (extra) =>
  normalizeSearch({ from: "SFO", to: "DFW", depart: "2026-09-29", timeout: 10, ...extra });
function browser(
  t,
  {
    month = "2026-10",
    duplicates = false,
    unavailable = null,
    noSuggestions = false,
    ignoreClose = false,
    ignoreDate = false,
  } = {},
) {
  const dom = new JSDOM(
    `<form id="reservationFlightSearchForm">
    <input type="radio" name="product" id="flightRadio"><input type="radio" name="product" checked>
    <input type="radio" name="tripType" id="flightSearchForm.tripType.roundTrip" checked>
    <input type="radio" name="tripType" id="flightSearchForm.tripType.oneWay">
    <input type="checkbox" id="flightSearchForm.tripType.redeemMiles" checked>
    <input id="reservationFlightSearchForm.originAirport" value="LAX"><input id="reservationFlightSearchForm.destinationAirport" value="JFK">
    <select id="flightSearchForm.adultOrSeniorPassengerCount">${Array.from({ length: 9 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select>
    <div class="js-date-picker-wrapper"><input id="aa-leavingOn" value="11/13/2026"><button type="button" class="ui-datepicker-trigger">Calendar</button></div>
    <div class="js-date-picker-wrapper"><input id="aa-returningFrom" value="11/20/2026"><button type="button" class="ui-datepicker-trigger">Calendar</button></div>
    <input type="submit" id="flightSearchForm.button.reSubmit">
    </form><div class="ui-autocomplete" hidden></div>
    <div id="ui-datepicker-div" hidden><button class="ui-datepicker-prev">Previous Month</button><table class="ui-datepicker-calendar"><tbody></tbody></table><button class="ui-datepicker-next">Next Month</button><button class="ui-datepicker-close">Close</button></div>
    <div id="onetrust-banner-sdk"><button aria-label="Dismiss">Dismiss</button></div>`,
    { url: "https://www.aa.com/homePage.do", runScripts: "outside-only" },
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
  const form = d.querySelector("form"),
    calendar = d.querySelector("#ui-datepicker-div"),
    menu = d.querySelector(".ui-autocomplete");
  const get = (id) => form.querySelector(`[id="${id}"]`);
  let time = 0,
    input = null,
    active = null,
    submitted = null;
  const selected = {},
    dateClicks = [];
  const render = () => {
    const body = calendar.querySelector("tbody");
    body.replaceChildren();
    const [y, m] = month.split("-").map(Number),
      count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let day = 1; day <= count; day++) {
      const iso = `${month}-${String(day).padStart(2, "0")}`;
      const td = d.createElement("td");
      td.dataset.year = y;
      td.dataset.month = m - 1;
      const a = d.createElement("a");
      a.dataset.date = day;
      a.textContent = day;
      a.href = "#";
      td.append(a);
      if (iso === unavailable) td.className = "ui-state-disabled";
      a.addEventListener("click", (event) => {
        event.preventDefault();
        assert.notEqual(iso, unavailable);
        dateClicks.push({ date: iso, time });
        if (ignoreDate) return;
        active.value = `${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}/${y}`;
        selected[active.id] = iso;
      });
      if (duplicates) {
        const hidden = td.cloneNode(true);
        hidden.className = "ui-datepicker-other-month";
        hidden.setAttribute("aria-hidden", "true");
        body.append(hidden);
      }
      body.append(td);
    }
  };
  for (const button of form.querySelectorAll(".ui-datepicker-trigger"))
    button.addEventListener("click", () => {
      active = button.previousElementSibling;
      calendar.hidden = false;
      render();
    });
  for (const [cls, change] of [
    ["prev", -1],
    ["next", 1],
  ])
    calendar.querySelector(`.ui-datepicker-${cls}`).addEventListener("click", () => {
      const next = new Date(`${month}-01T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + change);
      month = next.toISOString().slice(0, 7);
      render();
    });
  calendar.querySelector(".ui-datepicker-close").addEventListener("click", () => {
    if (!ignoreClose) calendar.hidden = true;
  });
  d.querySelector('[aria-label="Dismiss"]').addEventListener(
    "click",
    (e) => (e.target.parentElement.hidden = true),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    assert.ok(calendar.hidden && menu.hidden);
    submitted = {
      dates: { ...selected },
      from: get("reservationFlightSearchForm.originAirport").value,
      to: get("reservationFlightSearchForm.destinationAirport").value,
      adults: get("flightSearchForm.adultOrSeniorPassengerCount").value,
      miles: get("flightSearchForm.tripType.redeemMiles").checked,
      round: get("flightSearchForm.tripType.roundTrip").checked,
      flightOnly: get("flightRadio").checked,
    };
  });
  if (duplicates)
    for (const root of [form, calendar, menu])
      for (const type of ["hidden", "visibility", "aria"]) {
        const copy = root.cloneNode(true);
        if (type === "hidden") copy.hidden = true;
        else if (type === "aria") copy.setAttribute("aria-hidden", "true");
        else copy.style.visibility = "hidden";
        root.before(copy);
      }
  const page = {
    async evaluate(fn) {
      assert.equal(fn, readAaForm);
      return JSON.parse(JSON.stringify(w.eval(`(${fn.toString()})()`)));
    },
    async click(selector, { nth } = {}) {
      const all = d.querySelectorAll(selector);
      assert.ok(nth !== undefined || all.length === 1);
      const e = all[nth ?? 0];
      assert.ok(
        e &&
          e.getClientRects().length &&
          !e.disabled &&
          !e.closest('[hidden],[aria-hidden="true"],.ui-state-disabled'),
      );
      assert.notEqual(w.getComputedStyle(e).visibility, "hidden");
      e.focus();
      e.click();
    },
    async fillText(selector, value, { nth } = {}) {
      input = d.querySelectorAll(selector)[nth ?? 0];
      input.value = value;
      menu.hidden = false;
      menu.replaceChildren();
      if (noSuggestions) return;
      for (const code of ["ALL", value]) {
        const div = d.createElement("div");
        div.className = "ui-menu-item-wrapper";
        div.textContent = `${code} - Airport`;
        div.addEventListener("click", () => {
          assert.equal(code, value);
          input.value = code;
          menu.hidden = true;
        });
        menu.append(div);
      }
    },
    async pressKey(key) {
      const e = d.activeElement;
      if (key === "Home") e.selectedIndex = 0;
      else if (key === "ArrowDown") e.selectedIndex++;
      else assert.equal(key, "Tab");
    },
    async wait({ time: seconds }) {
      time += seconds * 1000;
    },
  };
  return { page, document: d, get, now: () => time, dateClicks, submitted: () => submitted };
}
for (const miles of [false, true])
  for (const round of [false, true])
    test(`submits homepage ${miles ? "award" : "cash"} ${round ? "round trip" : "one way"} with duplicate controls`, async (t) => {
      const b = browser(t, { duplicates: true });
      await submitAaSearch(
        b.page,
        search({ miles, adults: 2, ...(round ? { return: "2026-10-02" } : {}) }),
        { now: b.now },
      );
      assert.deepEqual(b.submitted(), {
        from: "SFO",
        to: "DFW",
        adults: "2",
        miles,
        round,
        flightOnly: true,
        dates: {
          "aa-leavingOn": "2026-09-29",
          ...(round ? { "aa-returningFrom": "2026-10-02" } : {}),
        },
      });
      assert.ok(b.dateClicks[0].time >= 500);
    });
test("selects a year-boundary round trip and nine adults", async (t) => {
  const b = browser(t, { month: "2027-02" });
  await submitAaSearch(b.page, search({ depart: "2026-12-31", return: "2027-01-02", adults: 9 }), {
    now: b.now,
  });
  assert.deepEqual(b.submitted().dates, {
    "aa-leavingOn": "2026-12-31",
    "aa-returningFrom": "2027-01-02",
  });
});
test("selects a same-day return in both controls", async (t) => {
  const b = browser(t);
  await submitAaSearch(b.page, search({ return: "2026-09-29" }), { now: b.now });
  assert.equal(b.submitted().dates["aa-returningFrom"], "2026-09-29");
});
for (const options of [
  { unavailable: "2026-09-29" },
  { noSuggestions: true },
  { ignoreClose: true },
  { ignoreDate: true },
])
  test(`never submits after failed interaction ${JSON.stringify(options)}`, async (t) => {
    const b = browser(t, options);
    await assert.rejects(
      submitAaSearch(b.page, search({ timeout: 5 }), { now: b.now }),
      /does not offer|suggest airport|close calendar|select 2026/,
    );
    assert.equal(b.submitted(), null);
  });
test("rejects an access challenge without clicking controls", async (t) => {
  const b = browser(t);
  b.document.body.insertAdjacentHTML("beforeend", "<h1>Access Denied</h1>");
  await assert.rejects(submitAaSearch(b.page, search(), { now: b.now }), /access challenge/);
  assert.equal(b.submitted(), null);
});
test("login redirects remain typed instead of falling back to cash", async (t) => {
  const b = browser(t);
  b.document.defaultView.history.replaceState({}, "", "/loyalty/login");
  await assert.rejects(
    submitAaSearch(b.page, search({ miles: true }), { now: b.now }),
    AaLoginRequiredError,
  );
});
test("reader returns no unrelated saved traveler text", async (t) => {
  const b = browser(t);
  b.document.body.insertAdjacentHTML("beforeend", "<aside>Private saved traveler</aside>");
  assert.ok(!JSON.stringify(await b.page.evaluate(readAaForm)).includes("Private saved traveler"));
});

test("missing homepage controls time out without submitting", async (t) => {
  const b = browser(t);
  b.document.querySelector("form").remove();
  await assert.rejects(
    submitAaSearch(b.page, search({ timeout: 5 }), { now: b.now }),
    /become ready/,
  );
  assert.equal(b.submitted(), null);
});
