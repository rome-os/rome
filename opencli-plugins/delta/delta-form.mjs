export const DELTA_HOME = "https://www.delta.com/";
export class DeltaLoginRequiredError extends Error {}

export function assertDeltaAvailable(data) {
  if (data.challenge)
    throw new Error("Delta served an access challenge. Clear it in the browser, then retry");
  if (data.service_error)
    throw new Error("Delta could not complete this search or the search expired. Retry later");
  if (data.login_required)
    throw new DeltaLoginRequiredError(
      "Sign in to SkyMiles on delta.com in this browser, then retry. Cash prices will not be substituted",
    );
}

/** Serialized into the page. Returns only public flight-search controls and their DOM indexes. */
export function readDeltaForm() {
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
    text: text(e),
    label: e.getAttribute("aria-label") || "",
    value: e.getAttribute("data-value") ?? e.value,
    disabled: !!e.disabled || e.getAttribute("aria-disabled") === "true",
    checked: e.checked ?? null,
    expanded: e.getAttribute("aria-expanded") === "true",
  });
  const one = (selector) => {
    const c = controls(selector)[0];
    return c ? describe(c) : null;
  };
  const calendar = controls('[role="dialog"][aria-label="Choose Dates"]')[0]?.e;
  const inCalendar = (selector) => controls(selector).filter(({ e }) => calendar?.contains(e));
  const calendarButton = (selector) => {
    const c = inCalendar(selector)[0];
    return c ? describe(c) : null;
  };
  const iso = (value) => {
    const m = value?.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
  };
  const dates = inCalendar("button[data-date-value]")
    .filter(({ e }) => !e.matches('[data-hidden="true"], [data-outside="true"], .placeholder'))
    .map((c) => ({
      ...describe(c),
      date: iso(c.e.getAttribute("data-date-value")),
      selected: c.e.classList.contains("selected") || c.e.getAttribute("aria-selected") === "true",
    }));
  return {
    challenge: /Access Denied|verify (?:that )?you are human|unusual traffic|Press & Hold/i.test(
      document.body?.innerText || "",
    ),
    service_error: controls('[role="alert"]').some(({ e }) =>
      /unable to complete|try again later/i.test(text(e)),
    ),
    login_required: controls('[role="dialog"]').some(({ e }) =>
      /log in to.*SkyMiles|sign in to.*SkyMiles/i.test(text(e)),
    ),
    privacy_notice: (() => {
      const notice = one("#onetrust-banner-sdk #onetrust-accept-btn-handler");
      return notice?.text === "I understand" ? notice : null;
    })(),
    origin: one('button[aria-label^="Origin,"], button[id$="-origin-button"]'),
    destination: one('button[aria-label^="Destination,"], button[id$="-destination-button"]'),
    trip: one('button[aria-label^="Trip Type,"]'),
    passengers: one('button[aria-label^="Passenger Count,"]'),
    cabin: one('button[aria-label^="Best Fares For,"]'),
    airport_input: one('input[id^="predictive_search_"]'),
    airport_options: controls(
      '[role="listbox"][aria-label="predictive_search_list"] [role="option"][title]',
    ).map((c) => ({ ...describe(c), code: c.e.getAttribute("title") })),
    options: controls('[role="option"][data-value]').map(describe),
    toggles: Object.fromEntries(
      [
        "shopWithMiles",
        "flexibleDate",
        "basicFaresField",
        "showExtraFareOnly",
        "includeNearByAirport",
      ].map((id) => [id, one(`[id="${id}"]`)]),
    ),
    date_trigger: one('button[aria-label^="Flight Date Field"]'),
    calendar_open: !!calendar,
    dates,
    clear: calendarButton(".date-picker__footer-clear-button"),
    done: calendarButton('button[aria-label$="Done Button"]'),
    previous: calendarButton('button[aria-label^="Previous month"]'),
    next: calendarButton('button[aria-label^="Next month"]'),
    submit: one('button[id="findFilghtsCta"]'),
  };
}

/** Submits homepage widgets. Does not build a search URL or select a fare. */
export async function submitDeltaSearch(page, search, { now = Date.now } = {}) {
  const deadline = now() + search.timeout * 1000;
  const waitFor = async (predicate, description) => {
    while (now() <= deadline) {
      const state = await page.evaluate(readDeltaForm);
      assertDeltaAvailable(state);
      if (state.privacy_notice)
        await page.click(state.privacy_notice.selector, { nth: state.privacy_notice.index });
      else if (await predicate(state)) return state;
      await page.wait({ time: 0.25 });
    }
    throw new Error(`Delta search form did not ${description} within ${search.timeout}s`);
  };
  const click = async (control) => {
    if (!control || control.disabled) throw new Error("Delta search control is unavailable");
    await page.click(control.selector, { nth: control.index });
  };
  let state = await waitFor((s) => s.submit && s.trip && s.origin, "become ready");
  await page.wait({ time: 0.5 });
  state = await waitFor(
    (s) => s.submit && s.trip && s.origin && s.destination,
    "finish loading controls",
  );
  const dropdown = async (key, value, label) => {
    await click(state[key]);
    state = await waitFor((s) => s.options.some((o) => o.value === value), `offer ${label}`);
    await click(state.options.find((o) => o.value === value));
    state = await waitFor(
      (s) =>
        s[key]?.label === label && s.origin && s.destination && s.passengers && !s.options.length,
      `select ${label}`,
    );
  };
  await dropdown(
    "trip",
    search.returnDate ? "ROUND_TRIP" : "ONE_WAY",
    `Trip Type, ${search.returnDate ? "Round Trip" : "One Way"}`,
  );
  for (const [key, code] of [
    ["origin", search.from],
    ["destination", search.to],
  ]) {
    state = await waitFor((s) => s[key], `show ${key} control`);
    await click(state[key]);
    state = await waitFor((s) => s.airport_input, "open airport picker");
    await page.fillText(state.airport_input.selector, code, { nth: state.airport_input.index });
    state = await waitFor(
      (s) => s.airport_options.some((o) => o.code === code),
      `suggest airport ${code}`,
    );
    await click(state.airport_options.find((o) => o.code === code));
    state = await waitFor(
      (s) => s[key]?.text.startsWith(code) && !s.airport_input,
      `select airport ${code}`,
    );
  }
  await dropdown("passengers", String(search.adults), `Passenger Count, ${search.adults}`);
  if (state.cabin && state.cabin.label !== "Best Fares For, Delta Main")
    throw new Error("Set Best Fares For to Delta Main in the browser, then retry");
  for (const [key, value] of Object.entries({
    shopWithMiles: search.miles,
    flexibleDate: false,
    basicFaresField: true,
    showExtraFareOnly: false,
    includeNearByAirport: false,
  })) {
    if (key === "includeNearByAirport" && !state.toggles[key]) continue;
    const c = state.toggles[key];
    if (!c || c.checked === null) throw new Error(`Delta search control is unavailable: ${key}`);
    if (c.checked !== value) {
      await click(c);
      state = await waitFor((s) => s.toggles[key]?.checked === value, `set ${key}`);
    }
  }
  await click(state.date_trigger);
  state = await waitFor((s) => s.calendar_open && s.dates.length, "open the calendar");
  await click(state.clear);
  state = await waitFor((s) => !s.dates.some((d) => d.selected), "clear remembered dates");
  for (const date of [search.depart, search.returnDate].filter(Boolean)) {
    for (let turn = 0; !state.dates.some((d) => d.date === date); turn++) {
      if (turn >= 24) throw new Error(`Delta's calendar does not offer ${date}`);
      const first = state.dates[0]?.date;
      const next = date < first ? state.previous : state.next;
      if (!next || next.disabled) throw new Error(`Delta's calendar does not offer ${date}`);
      await click(next);
      state = await waitFor(
        (s) => s.dates.length && s.dates[0].date !== first,
        "change calendar month",
      );
    }
    // Calendar animations can reorder cells with the same date.
    let snapshot = "",
      stableAt = now();
    state = await waitFor((s) => {
      const signature = JSON.stringify(s.dates);
      if (signature !== snapshot) {
        snapshot = signature;
        stableAt = now();
      }
      return now() - stableAt >= 500;
    }, "settle calendar");
    const day = state.dates.find((d) => d.date === date && !d.disabled);
    if (!day) throw new Error(`Delta's calendar does not offer ${date}`);
    await click(day);
    state = await waitFor(
      (s) => s.dates.some((d) => d.date === date && d.selected),
      `select ${date}`,
    );
  }
  await click(state.done);
  state = await waitFor((s) => !s.calendar_open, "apply dates and close the calendar");
  const label = (date) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const expected = `Flight Date Field, DepartDate ${label(search.depart)}${search.returnDate ? ` - ReturnDate ${label(search.returnDate)}` : ""}`;
  if (state.date_trigger?.label.replace(/\b0([1-9])\b/g, "$1") !== expected)
    throw new Error("Delta did not apply the requested dates");
  state = await waitFor((s) => s.submit && !s.submit.disabled, "enable Find Flights");
  if (
    !state.origin?.text.startsWith(search.from) ||
    !state.destination?.text.startsWith(search.to) ||
    state.trip?.label !== `Trip Type, ${search.returnDate ? "Round Trip" : "One Way"}` ||
    state.passengers?.label !== `Passenger Count, ${search.adults}` ||
    state.toggles.shopWithMiles?.checked !== search.miles ||
    state.toggles.flexibleDate?.checked !== false ||
    state.toggles.showExtraFareOnly?.checked !== false ||
    state.toggles.basicFaresField?.checked !== true
  )
    throw new Error("Delta changed the requested search controls");
  await click(state.submit);
}
