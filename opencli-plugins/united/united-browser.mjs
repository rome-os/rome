import { assertSearchPage } from "./united-helpers.mjs";
import { assertUnitedAvailable, submitUnitedSearch, UNITED_HOME } from "./united-form.mjs";
import { readUnitedPage } from "./united-page.mjs";

export { UnitedLoginRequiredError } from "./united-form.mjs";

export function expandAllFlights() {
  const button = [...document.querySelectorAll("button")].find(
    (element) =>
      /^Show all flights$/i.test((element.textContent || "").trim()) &&
      element.getClientRects().length &&
      !element.disabled,
  );
  if (!button) return false;
  button.click();
  return true;
}

/** Submits the search form and expands results. Never chooses a fare or reads account state. */
export async function loadUnitedFlights(
  page,
  search,
  { now = Date.now, submit = submitUnitedSearch } = {},
) {
  await page.goto(UNITED_HOME);
  await submit(page, search, { now });
  const deadline = now() + search.timeout * 1000;
  let previous = "";
  let expanded = false;
  let expectedTotal = null;
  while (now() <= deadline) {
    const data = await page.evaluate(readUnitedPage);
    const total = data.displayed[1];
    // The counter can disappear during expansion. Its highest total remains the completion bound.
    if (Number.isInteger(total) && total > 0) expectedTotal = Math.max(expectedTotal ?? 0, total);
    assertUnitedAvailable(data);
    if (!data.loading && (data.rows.length || data.no_results)) {
      assertSearchPage(data, search);
      if (data.no_results && !data.rows.length && expectedTotal === null && !expanded) return data;
      if (data.show_all && !expanded) {
        expanded = await page.evaluate(expandAllFlights);
        previous = "";
      } else {
        const complete =
          !data.show_all &&
          (expectedTotal !== null ? data.rows.length >= expectedTotal : !expanded);
        const signature = complete ? JSON.stringify(data.rows) : "";
        if (complete && signature === previous) return data;
        previous = signature;
      }
    } else {
      previous = "";
    }
    await page.wait({ time: 1 });
  }
  throw new Error(
    `United did not finish loading all flight results within ${search.timeout}s. Retry or increase --timeout. No partial prices were returned`,
  );
}
