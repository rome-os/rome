export const AA_HOME = "https://www.aa.com/homePage.do";
export class AaLoginRequiredError extends Error {}

/** Serialized into the page. Reads flight-search controls without account or authentication data. */
export function readAaForm() {
  const visible = (element) => {
    if (
      !element?.getClientRects().length ||
      element.closest('[hidden], [aria-hidden="true"], [inert]')
    )
      return false;
    for (let e = element; e; e = e.parentElement) {
      if (["hidden", "collapse"].includes(getComputedStyle(e).visibility)) return false;
    }
    return true;
  };
  const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
  // OpenCLI nth indexes count hidden DOM copies, so index before filtering.
  const controls = (selector) =>
    [...document.querySelectorAll(selector)]
      .map((e, index) => ({ e, selector, index }))
      .filter(({ e }) => visible(e));
  const describe = ({ e, selector, index }) => ({
    selector,
    index,
    value: e.value ?? null,
    text: text(e),
    checked: e.checked ?? null,
    disabled:
      !!e.disabled ||
      e.getAttribute("aria-disabled") === "true" ||
      !!e.closest(".ui-state-disabled"),
  });
  const one = (selector) => {
    const c = controls(selector)[0];
    return c ? describe(c) : null;
  };
  const field = (id) => one(`#reservationFlightSearchForm [id="${id}"]`);
  const calendar = controls("#ui-datepicker-div")[0]?.e;
  const inCalendar = (selector) => controls(selector).filter(({ e }) => calendar?.contains(e));
  const calendarControl = (selector) => {
    const c = inCalendar(selector)[0];
    return c ? describe(c) : null;
  };
  const days = inCalendar(".ui-datepicker-calendar td[data-year][data-month] a[data-date]")
    .filter(
      ({ e }) =>
        !e.closest('.ui-datepicker-other-month, [data-hidden="true"], [data-outside="true"]'),
    )
    .map((c) => {
      const td = c.e.closest("td");
      return {
        ...describe(c),
        date: `${td.dataset.year}-${String(Number(td.dataset.month) + 1).padStart(2, "0")}-${c.e.getAttribute("data-date").padStart(2, "0")}`,
      };
    });
  const trigger = (id) => {
    const input = controls(`#reservationFlightSearchForm [id="${id}"]`)[0]?.e;
    const c = controls("#reservationFlightSearchForm .ui-datepicker-trigger").find(({ e }) =>
      input?.closest(".js-date-picker-wrapper")?.contains(e),
    );
    return c ? describe(c) : null;
  };
  return {
    challenge: /Access Denied|verify (?:that )?you are human|unusual traffic|Press & Hold/i.test(
      document.body?.innerText || "",
    ),
    login_required: /\/loyalty\/login/.test(location.pathname),
    error:
      controls('[role="alert"]')
        .map(({ e }) => text(e))
        .find((t) => /unable to complete|try again later/i.test(t)) || null,
    cookie_close: one('#onetrust-banner-sdk [aria-label="Dismiss"]'),
    flight_only: field("flightRadio"),
    round_trip: field("flightSearchForm.tripType.roundTrip"),
    one_way: field("flightSearchForm.tripType.oneWay"),
    miles: field("flightSearchForm.tripType.redeemMiles"),
    origin: field("reservationFlightSearchForm.originAirport"),
    destination: field("reservationFlightSearchForm.destinationAirport"),
    airport_options: controls(".ui-autocomplete .ui-menu-item-wrapper").map((c) => ({
      ...describe(c),
      code: text(c.e).match(/^([A-Z]{3})\s*-/)?.[1] || null,
    })),
    adults: field("flightSearchForm.adultOrSeniorPassengerCount"),
    departure: field("aa-leavingOn"),
    return_date: field("aa-returningFrom"),
    departure_trigger: trigger("aa-leavingOn"),
    return_trigger: trigger("aa-returningFrom"),
    calendar_open: !!calendar,
    days,
    previous: calendarControl(".ui-datepicker-prev"),
    next: calendarControl(".ui-datepicker-next"),
    close: calendarControl(".ui-datepicker-close"),
    submit: field("flightSearchForm.button.reSubmit"),
  };
}

/** Submits homepage widgets. Never constructs a search URL or chooses a fare. */
export async function submitAaSearch(page, search, { now = Date.now } = {}) {
  const deadline = now() + search.timeout * 1000;
  const click = async (c) => {
    if (!c || c.disabled) throw new Error("AA search control is unavailable");
    await page.click(c.selector, { nth: c.index });
  };
  const waitFor = async (predicate, description) => {
    while (now() <= deadline) {
      const s = await page.evaluate(readAaForm);
      if (s.challenge)
        throw new Error("AA served an access challenge. Resolve it in the browser, then retry");
      if (s.login_required)
        throw new AaLoginRequiredError(
          "Log in to aa.com in this browser, then retry. Cash fares will not be substituted for miles",
        );
      if (s.error) throw new Error(`AA could not complete the search: ${s.error}`);
      if (s.cookie_close) await click(s.cookie_close);
      else if (predicate(s)) return s;
      await page.wait({ time: 0.25 });
    }
    throw new Error(`AA search form did not ${description} within ${search.timeout}s`);
  };
  let state = await waitFor((s) => s.submit && s.origin && s.round_trip, "become ready");
  for (const [key, value] of [
    ["flight_only", true],
    [search.returnDate ? "round_trip" : "one_way", true],
    ["miles", search.miles],
  ]) {
    if (!state[key]) throw new Error(`AA search control is unavailable: ${key}`);
    if (state[key].checked !== value) {
      await click(state[key]);
      state = await waitFor((s) => s[key]?.checked === value, `set ${key}`);
    }
  }
  for (const [key, code] of [
    ["origin", search.from],
    ["destination", search.to],
  ]) {
    await click(state[key]);
    await page.fillText(state[key].selector, code, { nth: state[key].index });
    state = await waitFor(
      (s) => s.airport_options.some((o) => o.code === code),
      `suggest airport ${code}`,
    );
    await click(state.airport_options.find((o) => o.code === code));
    state = await waitFor(
      (s) => s[key]?.value === code && !s.airport_options.length,
      `select airport ${code}`,
    );
  }
  await click(state.adults);
  await page.pressKey("Home");
  for (let i = 1; i < search.adults; i++) await page.pressKey("ArrowDown");
  await page.pressKey("Tab");
  state = await waitFor((s) => s.adults?.value === String(search.adults), "set adult count");
  for (const [key, trigger, date] of [
    ["departure", "departure_trigger", search.depart],
    ["return_date", "return_trigger", search.returnDate],
  ]) {
    if (!date) continue;
    await click(state[trigger]);
    state = await waitFor((s) => s.calendar_open && s.days.length, "open calendar");
    for (let turn = 0; !state.days.some((d) => d.date === date); turn++) {
      if (turn >= 24) throw new Error(`AA's calendar does not offer ${date}`);
      const first = state.days[0].date,
        control = date < first ? state.previous : state.next;
      if (!control || control.disabled) throw new Error(`AA's calendar does not offer ${date}`);
      await click(control);
      state = await waitFor(
        (s) => s.days.length && s.days[0].date !== first,
        "change calendar month",
      );
    }
    // Calendar animations can reorder cells with the same date.
    let snapshot = "",
      stableAt = now();
    state = await waitFor((s) => {
      const signature = JSON.stringify(s.days);
      if (signature !== snapshot) {
        snapshot = signature;
        stableAt = now();
      }
      return now() - stableAt >= 500;
    }, "settle calendar");
    const day = state.days.find((d) => d.date === date && !d.disabled);
    if (!day) throw new Error(`AA's calendar does not offer ${date}`);
    await click(day);
    const value = `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
    state = await waitFor((s) => s[key]?.value === value, `select ${date}`);
    if (state.calendar_open) {
      await click(state.close);
      state = await waitFor((s) => !s.calendar_open, "close calendar");
    }
  }
  state = await waitFor((s) => s.submit && !s.submit.disabled, "enable search");
  if (
    state.origin?.value !== search.from ||
    state.destination?.value !== search.to ||
    state.adults?.value !== String(search.adults) ||
    state.miles?.checked !== search.miles ||
    !state[search.returnDate ? "round_trip" : "one_way"]?.checked ||
    !state.flight_only?.checked
  )
    throw new Error("AA changed the requested search controls");
  await click(state.submit);
}
