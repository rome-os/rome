export const UNITED_HOME = "https://www.united.com/en/us";
const FORM = "#bookFlightForm";
const TRAVELERS = `${FORM} input[aria-describedby="uaPaxSelectorMainButtonAriaDescription"]`;
const COOKIE_CLOSE = '[role="dialog"][aria-label="cookieconsent"] [aria-label="Close banner"]';

export class UnitedLoginRequiredError extends Error {}

export function assertUnitedAvailable(data) {
  if (data.challenge)
    throw new Error("United served an access challenge. Clear it in the browser, then retry");
  if (data.service_error) throw new Error("United could not complete this search. Retry later");
  if (data.login_required)
    throw new UnitedLoginRequiredError(
      "Sign in to MileagePlus on united.com in this browser, then retry --miles. Cash prices will not be substituted",
    );
}

/** Serialized into the page. Reads search controls without returning saved traveler identities. */
export function readUnitedSearchForm() {
  const visible = (element) =>
    element &&
    !!element.getClientRects().length &&
    !element.closest('[hidden], [aria-hidden="true"]') &&
    !["hidden", "collapse"].includes(getComputedStyle(element).visibility);
  const text = (element) => (element?.textContent || "").replace(/\s+/g, " ").trim();
  const form = document.querySelector("#bookFlightForm");
  const get = (selector) => form?.querySelector(selector);
  const buttons = [...(form?.querySelectorAll("button") || [])];
  const button = (label) => {
    const index = buttons.findIndex((element) => visible(element) && text(element) === label);
    if (index < 0) return null;
    const element = buttons[index];
    return {
      selector: "#bookFlightForm button",
      index,
      disabled: element.disabled,
    };
  };
  const options = (id) =>
    [...document.querySelectorAll(`[id="${id}-menu"][role="listbox"] [role="option"]`)]
      .filter((element) => visible(element) && element.id)
      .map((element) => ({
        selector: `[id="${id}-menu"][role="listbox"] [role="option"][id=${JSON.stringify(element.id)}]`,
        code: text(element).match(/\(([A-Z]{3})\)$/)?.[1],
      }));
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const calendar = dialogs.find((element) =>
    /^Choose (?:dates|a date)$/.test(element.getAttribute("aria-label") || ""),
  );
  const calendarSelector =
    '[role="dialog"]:is([aria-label="Choose dates"], [aria-label="Choose a date"])';
  const calendarControls = (suffix) => {
    const selector = `${calendarSelector} ${suffix}`;
    // OpenCLI's nth counts all selector matches, including hidden calendar copies.
    return [...document.querySelectorAll(selector)]
      .map((element, index) => ({ element, selector, index }))
      .filter(({ element }) => calendar?.contains(element) && visible(element));
  };
  const days = calendarControls('[role="gridcell"][data-day]')
    .filter(({ element }) => !element.matches('[data-hidden="true"], [data-outside="true"]'))
    .map(({ element, selector, index }) => ({
      selector,
      index,
      date: element.getAttribute("data-day"),
      disabled:
        element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled"),
    }));
  const closeCalendar = calendarControls("button").find(
    ({ element }) => !element.disabled && text(element) === "Close",
  );
  const monthButton = (direction) => {
    const control = calendarControls(`button[aria-label="${direction} month"]`).find(
      ({ element }) => !element.disabled && element.getAttribute("aria-disabled") !== "true",
    );
    return control ? { selector: control.selector, index: control.index } : null;
  };
  const checked = (id) => get(`#${id}`)?.checked ?? null;
  const body = document.body?.innerText || "";
  return {
    ready: !!visible(form) && !!get('button[aria-label="Find flights"]'),
    cookie_close: !!visible(
      document.querySelector(
        '[role="dialog"][aria-label="cookieconsent"] [aria-label="Close banner"]',
      ),
    ),
    challenge:
      /Access Denied|verify (?:that )?you are human|unusual traffic|Press & Hold|Your access to this site has been blocked/i.test(
        body,
      ),
    service_error: [...document.querySelectorAll('[role="alert"]')].some((element) =>
      /unable to complete your request|please try again later/i.test(text(element)),
    ),
    login_required: dialogs.some((dialog) =>
      /Email or MileagePlus|must be signed-in to see flight results with miles/i.test(text(dialog)),
    ),
    round_trip: checked("radiofield-item-id-flightType-0"),
    one_way: checked("radiofield-item-id-flightType-1"),
    miles: checked("award"),
    flexible: checked("flexibleDates"),
    basic: checked("includeBasicFares"),
    origin: get("#bookFlightOriginInput")?.value || "",
    destination: get("#bookFlightDestinationInput")?.value || "",
    origin_options: options("bookFlightOriginInput"),
    destination_options: options("bookFlightDestinationInput"),
    departure: get('input[aria-label="Departure"]')?.value || "",
    return_date: get('input[aria-label="Return"]')?.value || "",
    travelers: get('input[aria-describedby="uaPaxSelectorMainButtonAriaDescription"]')?.value || "",
    traveler_total:
      [...(form?.querySelectorAll('[role="status"]') || [])]
        .map(text)
        .find((value) => /^Total:/.test(value)) || "",
    reset: button("Reset"),
    increase_adults: button("Increase number of Adults (18+) by 1"),
    decrease_adults: button("Decrease number of Adults (18+) by 1"),
    close_travelers: button("Close dialog"),
    cabin: get("#cabinType")?.selectedOptions[0]?.textContent || "",
    calendar_open: !!calendar,
    close_calendar: closeCalendar
      ? { selector: closeCalendar.selector, index: closeCalendar.index }
      : null,
    days,
    previous_month: monthButton("Previous"),
    next_month: monthButton("Next"),
    submit_enabled:
      !!get('button[aria-label="Find flights"]') &&
      !get('button[aria-label="Find flights"]').disabled,
  };
}

/** Fills and submits the homepage widgets. Never constructs a results URL or selects a fare. */
export async function submitUnitedSearch(page, search, { now = Date.now } = {}) {
  const deadline = now() + search.timeout * 1000;
  const waitFor = async (predicate, description) => {
    while (now() <= deadline) {
      const state = await page.evaluate(readUnitedSearchForm);
      assertUnitedAvailable(state);
      if (state.cookie_close) {
        await page.click(COOKIE_CLOSE);
      } else if (predicate(state)) return state;
      await page.wait({ time: 0.25 });
    }
    throw new Error(`United search form did not ${description} within ${search.timeout}s`);
  };
  let state = await waitFor((s) => s.ready, "become ready");
  const setToggle = async (key, selector, value) => {
    if (state[key] === null) throw new Error(`United search control is unavailable: ${key}`);
    if (state[key] !== value) {
      await page.click(selector);
      state = await waitFor((s) => s[key] === value, `accept ${key}`);
    }
  };
  await setToggle(
    search.returnDate ? "round_trip" : "one_way",
    `${FORM} #radiofield-item-id-flightType-${search.returnDate ? 0 : 1}`,
    true,
  );
  await setToggle("miles", `${FORM} #award`, search.miles);
  await setToggle("flexible", `${FORM} #flexibleDates`, false);
  if (!search.miles && state.basic !== null)
    await setToggle("basic", `${FORM} #includeBasicFares`, true);

  for (const [key, id, code] of [
    ["origin", "bookFlightOriginInput", search.from],
    ["destination", "bookFlightDestinationInput", search.to],
  ]) {
    await page.click(`${FORM} #${id}`);
    await page.fillText(`${FORM} #${id}`, "");
    await page.fillText(`${FORM} #${id}`, code);
    state = await waitFor(
      (s) => s[`${key}_options`].some((option) => option.code === code),
      `suggest airport ${code}`,
    );
    const option = state[`${key}_options`].find((candidate) => candidate.code === code);
    await page.click(option.selector);
    state = await waitFor(
      (s) => s[key].endsWith(` ${code}`) && s[`${key}_options`].length === 0,
      `select airport ${code}`,
    );
  }

  await page.click(TRAVELERS);
  state = await waitFor(
    (s) => s.increase_adults && s.close_travelers,
    "open the traveler selector",
  );
  if (state.reset && !state.reset.disabled) {
    await page.click(state.reset.selector, { nth: state.reset.index });
    state = await waitFor((s) => /^Total: 1 Adult$/.test(s.traveler_total), "reset travelers");
  }
  for (let attempts = 0; attempts < 9; attempts++) {
    const match = state.traveler_total.match(/^Total: ([1-9]) Adults?$/);
    if (!match)
      throw new Error(
        "United must show adult travelers only. Reset travelers in the browser, then retry",
      );
    const count = Number(match[1]);
    if (count === search.adults) break;
    const control = count < search.adults ? state.increase_adults : state.decrease_adults;
    if (!control || control.disabled)
      throw new Error("United cannot set the requested adult count");
    await page.click(control.selector, { nth: control.index });
    state = await waitFor(
      (s) => s.traveler_total !== state.traveler_total,
      "update the adult count",
    );
  }
  await page.click(state.close_travelers.selector, { nth: state.close_travelers.index });
  state = await waitFor(
    (s) =>
      s.travelers === `${search.adults} Adult${search.adults === 1 ? "" : "s"}` &&
      !s.close_travelers,
    "apply travelers",
  );

  // Cabin remains a filter over all displayed fare columns, so search from the Economy baseline.
  if (state.cabin !== "Economy") {
    await page.click(`${FORM} #cabinType`);
    await page.pressKey("Home");
    await page.pressKey("Tab");
    state = await waitFor((s) => s.cabin === "Economy", "select Economy");
  }
  for (const [label, date] of [
    ["Departure", search.depart],
    ["Return", search.returnDate],
  ]) {
    if (!date) continue;
    await page.click(`${FORM} input[aria-label="${label}"]`);
    state = await waitFor((s) => s.calendar_open && s.days.length, "open the calendar");
    for (let turns = 0; !state.days.some((day) => day.date === date); turns++) {
      if (turns >= 24) throw new Error(`United's calendar does not offer ${date}`);
      const previous = date < state.days[0].date;
      const control = previous ? state.previous_month : state.next_month;
      if (!control) throw new Error(`United's calendar does not offer ${date}`);
      const firstDate = state.days[0].date;
      await page.click(control.selector, { nth: control.index });
      state = await waitFor(
        (s) => s.days.length && s.days[0].date !== firstDate,
        "change calendar month",
      );
    }
    const day = state.days.find((day) => day.date === date && !day.disabled);
    if (!day) throw new Error(`United's calendar does not offer ${date}`);
    await page.click(day.selector, { nth: day.index });
    const expected = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    state = await waitFor(
      (s) =>
        s[label === "Departure" ? "departure" : "return_date"].replace(/\b0([1-9])\b/g, "$1") ===
        expected,
      `select ${label.toLowerCase()} date`,
    );
    if (state.calendar_open) {
      if (state.close_calendar)
        await page.click(state.close_calendar.selector, { nth: state.close_calendar.index });
      else await page.pressKey("Escape");
      state = await waitFor((s) => !s.calendar_open, "close the calendar");
    }
  }
  await waitFor((s) => s.submit_enabled, "enable Find flights");
  await page.click(`${FORM} button[aria-label="Find flights"]`);
}
