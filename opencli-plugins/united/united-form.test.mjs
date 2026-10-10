import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { loadUnitedFlights } from "./united-browser.mjs";
import {
  readUnitedSearchForm,
  submitUnitedSearch,
  UNITED_HOME,
  UnitedLoginRequiredError,
} from "./united-form.mjs";
import { normalizeSearch } from "./united-helpers.mjs";

const { JSDOM } = createRequire(new URL("../../packages/web/package.json", import.meta.url))(
  "jsdom",
);
const html = readFileSync(new URL("./fixtures/search-form.html", import.meta.url), "utf8");
const cash = JSON.parse(readFileSync(new URL("./fixtures/cash.json", import.meta.url)));
const search = (extra = {}) =>
  normalizeSearch({ from: "SFO", to: "IAH", depart: "2026-11-13", ...extra });

function formBrowser(t, { month = "2026-10", unavailable = null, noSuggestions = false } = {}) {
  const dom = new JSDOM(html, { url: UNITED_HOME, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{}];
  };
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  const form = document.querySelector("form");
  const passengers = document.querySelector("#passengers");
  const travelers = form.querySelector('input[type="button"]');
  const calendar = document.querySelector('[aria-label="Choose dates"]');
  const dateValue = (date) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  let activeDate;
  let time = 0;
  let submitted = null;
  let arrivalPolls = 0;
  const calls = [];
  const selectedDates = {};
  const updateTravelers = (count) => {
    travelers.value = `${count} Adult${count === 1 ? "" : "s"}`;
    passengers.querySelector('[role="status"]').textContent = `Total: ${travelers.value}`;
  };
  const renderCalendar = () => {
    const row = calendar.querySelector("tr");
    row.replaceChildren();
    const [year, number] = month.split("-").map(Number);
    const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
    for (let day = 1; day <= count; day++) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      const cell = document.createElement("td");
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("data-day", date);
      if (date === unavailable) cell.setAttribute("aria-disabled", "true");
      cell.textContent = String(day);
      cell.addEventListener("click", () => {
        assert.notEqual(date, unavailable);
        selectedDates[activeDate.getAttribute("aria-label")] = date;
        activeDate.value = form.querySelector('[value="oneWay"]').checked
          ? dateValue(date).replace(/ (\d)$/, " 0$1")
          : dateValue(date);
        if (
          activeDate.getAttribute("aria-label") === "Return" ||
          form.querySelector('[value="oneWay"]').checked
        )
          calendar.hidden = true;
      });
      row.append(cell);
    }
  };
  calendar.querySelector(".atm-c-datepicker__close-btn").addEventListener("click", () => {
    calendar.hidden = true;
  });
  for (const button of calendar.querySelectorAll('button[aria-label$="month"]')) {
    button.addEventListener("click", () => {
      const next = new Date(`${month}-01T00:00:00Z`);
      next.setUTCMonth(
        next.getUTCMonth() + (button.getAttribute("aria-label") === "Next month" ? 1 : -1),
      );
      month = next.toISOString().slice(0, 7);
      renderCalendar();
    });
  }
  for (const input of form.querySelectorAll(
    'input[aria-label="Departure"],input[aria-label="Return"]',
  )) {
    input.addEventListener("click", () => {
      activeDate = input;
      calendar.setAttribute(
        "aria-label",
        form.querySelector('[value="oneWay"]').checked ? "Choose a date" : "Choose dates",
      );
      calendar.hidden = false;
      renderCalendar();
    });
  }
  travelers.addEventListener("click", () => {
    passengers.hidden = false;
  });
  for (const button of passengers.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      const label = button.textContent;
      if (label === "Reset") updateTravelers(1);
      else if (label === "Close dialog") passengers.hidden = true;
      else
        updateTravelers(
          Number(travelers.value.match(/^\d+/)[0]) + (label.startsWith("Increase") ? 1 : -1),
        );
    });
  }
  document.querySelector('[aria-label="Close banner"]').addEventListener("click", (event) => {
    event.target.parentElement.hidden = true;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    assert.ok(calendar.hidden && passengers.hidden, "overlays must close before submission");
    submitted = {
      origin: form.querySelector("#bookFlightOriginInput").value,
      destination: form.querySelector("#bookFlightDestinationInput").value,
      miles: form.querySelector("#award").checked,
      flexible: form.querySelector("#flexibleDates").checked,
      basic: form.querySelector("#includeBasicFares").checked,
      roundTrip: form.querySelector('[value="roundTrip"]').checked,
      travelers: travelers.value,
      cabin: form.querySelector("select").selectedOptions[0].textContent,
      dates: { ...selectedDates },
    };
  });
  const page = {
    async goto(url) {
      calls.push(["goto", url]);
      assert.equal(url, UNITED_HOME);
    },
    async evaluate(fn) {
      if (fn === readUnitedSearchForm)
        return JSON.parse(JSON.stringify(window.eval(`(${fn.toString()})()`)));
      assert.ok(submitted, "results cannot be read before submitting the widgets");
      arrivalPolls++;
      return structuredClone(cash);
    },
    async wait({ time: seconds }) {
      time += seconds * 1000;
    },
    async fillText(selector, value) {
      calls.push(["fill", selector, value]);
      const input = document.querySelector(selector);
      input.value = value;
      input.focus();
      const menu = document.getElementById(`${input.id}-menu`);
      menu.replaceChildren();
      if (noSuggestions) return;
      const labels = [`City, US (All Airports)`, `Recent trip to ${value}`, `City, US (${value})`];
      for (const [index, label] of labels.entries()) {
        const option = document.createElement("li");
        option.id = `autocomplete-item-${index}`;
        option.setAttribute("role", "option");
        option.textContent = label;
        option.addEventListener("click", () => {
          assert.equal(label, `City, US (${value})`, "select the exact airport suggestion");
          input.value = `City ${value}`;
          menu.hidden = true;
        });
        menu.append(option);
      }
      menu.hidden = false;
    },
    async click(selector, options = {}) {
      calls.push(["click", selector]);
      const elements = [...document.querySelectorAll(selector)];
      assert.ok(
        options.nth !== undefined || elements.length === 1,
        `ambiguous selector: ${selector}`,
      );
      const element = elements[options.nth ?? 0];
      assert.ok(element && element.getClientRects().length, `missing/hidden control: ${selector}`);
      assert.ok(!element.disabled);
      element.focus();
      element.click();
    },
    async pressKey(key) {
      calls.push(["key", key]);
      if (key === "Escape") return;
      else if (key === "Home") document.activeElement.options[0].selected = true;
      else assert.equal(key, "Tab", "Enter can submit the form prematurely");
    },
  };
  return {
    page,
    calls,
    document,
    now: () => time,
    submitted: () => submitted,
    arrivalPolls: () => arrivalPolls,
  };
}

test("submits a cash one-way search after replacing remembered widgets", async (t) => {
  const b = formBrowser(t);
  await submitUnitedSearch(b.page, search(), { now: b.now });
  assert.deepEqual(b.submitted(), {
    origin: "City SFO",
    destination: "City IAH",
    miles: false,
    flexible: false,
    basic: true,
    roundTrip: false,
    travelers: "1 Adult",
    cabin: "Economy",
    dates: { Departure: "2026-11-13" },
  });
  assert.equal(b.calls.filter(([action]) => action === "goto").length, 0);
});

test("selects round-trip award dates across the year boundary and nine adults", async (t) => {
  const b = formBrowser(t, { month: "2027-02" });
  await submitUnitedSearch(
    b.page,
    search({ depart: "2026-12-31", return: "2027-01-02", miles: true, adults: 9 }),
    { now: b.now },
  );
  const result = b.submitted();
  assert.equal(result.miles, true);
  assert.equal(result.roundTrip, true);
  assert.equal(result.travelers, "9 Adults");
  assert.deepEqual(result.dates, { Departure: "2026-12-31", Return: "2027-01-02" });
  assert.ok(b.calls.some(([, selector]) => selector?.includes("Previous month")));
  assert.ok(b.calls.some(([, selector]) => selector?.includes("Next month")));
});

test("closes the calendar with its Close button when Escape has no effect", async (t) => {
  const b = formBrowser(t);
  await submitUnitedSearch(b.page, search({ return: "2026-11-15" }), { now: b.now });
  assert.ok(b.submitted());
  assert.ok(!b.calls.some(([action, key]) => action === "key" && key === "Escape"));
});

test("selects the same date separately for departure and return", async (t) => {
  const b = formBrowser(t);
  await submitUnitedSearch(b.page, search({ return: "2026-11-13" }), { now: b.now });
  assert.deepEqual(b.submitted().dates, { Departure: "2026-11-13", Return: "2026-11-13" });
});

test("accepts the one-way calendar's zero-padded date label", async (t) => {
  const b = formBrowser(t, { month: "2027-01" });
  await submitUnitedSearch(b.page, search({ depart: "2027-01-02" }), { now: b.now });
  assert.deepEqual(b.submitted().dates, { Departure: "2027-01-02" });
});

for (const { duplicateFirst, hiddenStyle, returnDate } of [
  { duplicateFirst: false, hiddenStyle: true, returnDate: "2026-10-02" },
  { duplicateFirst: true, hiddenStyle: true, returnDate: "2026-10-02" },
  { duplicateFirst: true, hiddenStyle: false, returnDate: undefined },
]) {
  test(`selects real days with overlap duplicates: first=${duplicateFirst}, CSS hidden=${hiddenStyle}, return=${returnDate}`, async (t) => {
    const b = formBrowser(t, { month: "2026-09" });
    const calendar = b.document.querySelector('[aria-label="Choose dates"]');
    const duplicateDays = () => {
      for (const cell of [...calendar.querySelectorAll('[role="gridcell"][data-day]')]) {
        const duplicate = cell.cloneNode(true);
        duplicate.className = "rdp-day rdp-hidden rdp-outside";
        duplicate.setAttribute("data-hidden", "true");
        duplicate.setAttribute("data-outside", "true");
        if (hiddenStyle) duplicate.style.visibility = "hidden";
        cell[duplicateFirst ? "before" : "after"](duplicate);
      }
    };
    for (const control of b.document.querySelectorAll(
      'input[aria-label="Departure"], input[aria-label="Return"], [aria-label="Choose dates"] button',
    ))
      control.addEventListener("click", duplicateDays);
    await submitUnitedSearch(b.page, search({ depart: "2026-09-29", return: returnDate }), {
      now: b.now,
    });
    assert.deepEqual(b.submitted().dates, {
      Departure: "2026-09-29",
      ...(returnDate ? { Return: returnDate } : {}),
    });
  });
}

test("ignores a hidden calendar before the active calendar during month navigation", async (t) => {
  const b = formBrowser(t, { month: "2026-10" });
  const calendar = b.document.querySelector('[aria-label="Choose dates"]');
  const hidden = calendar.cloneNode(true);
  hidden.innerHTML += '<table><tr><td role="gridcell" data-day="2026-11-13"></td></tr></table>';
  calendar.before(hidden);
  await submitUnitedSearch(b.page, search({ return: "2026-11-13" }), { now: b.now });
  assert.deepEqual(b.submitted().dates, { Departure: "2026-11-13", Return: "2026-11-13" });
});

test("does not submit unavailable dates or unresolved airport suggestions", async (t) => {
  for (const options of [{ unavailable: "2026-11-13" }, { noSuggestions: true }]) {
    const b = formBrowser(t, options);
    await assert.rejects(
      submitUnitedSearch(b.page, search({ timeout: 5 }), { now: b.now }),
      /does not offer|suggest airport/,
    );
    assert.equal(b.submitted(), null);
  }
});

test("maps a sign-in wall during form setup to authentication required", async (t) => {
  const b = formBrowser(t);
  const dialog = b.document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.textContent = "You must be signed-in to see flight results with miles";
  b.document.body.append(dialog);
  await assert.rejects(
    submitUnitedSearch(b.page, search({ miles: true }), { now: b.now }),
    UnitedLoginRequiredError,
  );
  assert.equal(b.submitted(), null);
});

test("form reader returns no saved traveler text", async (t) => {
  const b = formBrowser(t);
  b.document.querySelector("#passengers").hidden = false;
  assert.ok(
    !JSON.stringify(await b.page.evaluate(readUnitedSearchForm)).includes("Private saved traveler"),
  );
});

test("loads results only after submitting widgets and navigates only to the homepage", async (t) => {
  const b = formBrowser(t);
  await loadUnitedFlights(b.page, search({ return: "2026-11-15", adults: 2 }), { now: b.now });
  assert.deepEqual(
    b.calls.filter(([action]) => action === "goto"),
    [["goto", UNITED_HOME]],
  );
  assert.ok(b.submitted());
  assert.equal(b.arrivalPolls(), 2);
});
