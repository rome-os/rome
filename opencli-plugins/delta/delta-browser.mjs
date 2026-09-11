import { assertSearchPage, buildSearchUrl } from "./delta-helpers.mjs";
import { readDeltaPage } from "./delta-page.mjs";

export class DeltaLoginRequiredError extends Error {}

/** Serialized into the browser. Sets only public search controls, never account preferences. */
export function prepareSearchForm(options) {
  const visible = (e) =>
    e && e.getClientRects().length && !e.closest('[hidden], [aria-hidden="true"]');
  const button = [...document.querySelectorAll('button[id="findFilghtsCta"]')].find(
    (e) => e.getClientRects().length,
  );
  if (!visible(button)) throw new Error("Delta search form is not ready");
  const get = (prefix) =>
    [...document.querySelectorAll("button[aria-label]")].find(
      (e) => visible(e) && e.getAttribute("aria-label").startsWith(prefix),
    );
  const origin = get("Origin,");
  const destination = get("Destination,");
  if (
    !origin?.textContent.trim().startsWith(options.from) ||
    !destination?.textContent.trim().startsWith(options.to)
  )
    throw new Error("Delta did not prefill the requested airports");
  if (
    get("Trip Type,")?.getAttribute("aria-label") !==
      `Trip Type, ${options.returnDate ? "Round Trip" : "One Way"}` ||
    get("Passenger Count,")?.getAttribute("aria-label") !== `Passenger Count, ${options.adults}`
  )
    throw new Error("Delta did not prefill the requested trip type or passenger count");
  if (get("Best Fares For,")?.getAttribute("aria-label") !== "Best Fares For, Delta Main")
    throw new Error("Set Best Fares For to Delta Main in the browser, then retry");
  const values = {
    shopWithMiles: options.miles,
    flexibleDate: false,
    basicFaresField: true,
    showExtraFareOnly: false,
    includeNearByAirport: false,
  };
  for (const [id, value] of Object.entries(values)) {
    const control = [...document.querySelectorAll(`[id="${id}"]`)].find(visible);
    if (!control || control.type !== "checkbox" || !visible(control))
      throw new Error(`Delta search control is unavailable: ${id}`);
    if (control.checked !== value) {
      if (control.disabled) throw new Error(`Delta search control is disabled: ${id}`);
      control.click();
    }
    if (control.checked !== value) throw new Error(`Delta did not accept search control: ${id}`);
  }
  return true;
}

export function submitSearchForm() {
  const button = [...document.querySelectorAll('button[id="findFilghtsCta"]')].find(
    (e) => e.getClientRects().length,
  );
  if (!button || button.disabled || !button.getClientRects().length)
    throw new Error("Delta Find Flights button is unavailable");
  button.click();
  return true;
}

export function expandMoreFlights() {
  const button = [...document.querySelectorAll("button")].find(
    (e) =>
      /^See More Results$/i.test(e.textContent.trim()) && e.getClientRects().length && !e.disabled,
  );
  if (!button) return false;
  button.click();
  return true;
}

function assertAvailable(data) {
  if (data.challenge)
    throw new Error("Delta served an access challenge. Clear it in the browser, then retry");
  if (data.service_error)
    throw new Error("Delta could not complete this search or the search expired. Retry later");
  if (data.login_required)
    throw new DeltaLoginRequiredError(
      "Sign in to SkyMiles on delta.com in this browser, then retry. Cash prices will not be substituted",
    );
}

/** Navigates, submits a search, and expands results. Never selects a flight or creates a booking. */
export async function loadDeltaFlights(page, search, { now = Date.now } = {}) {
  const deadline = now() + search.timeout * 1000;
  await page.goto("about:blank");
  await page.goto(buildSearchUrl(search));
  let submitted = false;
  while (now() <= deadline) {
    const data = await page.evaluate(readDeltaPage);
    assertAvailable(data);
    if (data.form_ready) {
      await page.evaluate(`(${prepareSearchForm.toString()})(${JSON.stringify(search)})`);
      // The click can destroy the JavaScript context. Preparation and result reads are separate calls.
      await page.evaluate(submitSearchForm);
      submitted = true;
      break;
    }
    await page.wait({ time: 1 });
  }
  if (!submitted)
    throw new Error(`Delta search form did not become ready within ${search.timeout}s`);
  let expectedTotal = null;
  let expandedAt = -1;
  let previous = "";
  while (now() <= deadline) {
    const data = await page.evaluate(readDeltaPage);
    assertAvailable(data);
    if (Number.isInteger(data.total) && data.total > 0)
      expectedTotal = Math.max(expectedTotal || 0, data.total);
    if (!data.loading && (data.rows.length || data.no_results)) {
      assertSearchPage(data, search);
      if (data.no_results && !data.rows.length && expectedTotal === null && expandedAt < 0)
        return data;
      if (data.more && data.rows.length > expandedAt) {
        if (await page.evaluate(expandMoreFlights)) expandedAt = data.rows.length;
        previous = "";
      } else {
        const complete = !data.more && expectedTotal !== null && data.rows.length === expectedTotal;
        const signature = complete
          ? JSON.stringify({ rows: data.rows, search: data.search, price_mode: data.price_mode })
          : "";
        if (complete && signature === previous) return { ...data, total: expectedTotal };
        previous = signature;
      }
    } else previous = "";
    await page.wait({ time: 1 });
  }
  throw new Error(
    `Delta did not finish loading all flights within ${search.timeout}s. Retry or increase --timeout. No partial prices were returned`,
  );
}
