import { assertSearchPage, buildSearchUrl } from "./united-helpers.mjs";
import { readUnitedPage } from "./united-page.mjs";

export class UnitedLoginRequiredError extends Error {}

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

/** Only navigates and expands search results. Never chooses a fare or reads account state. */
export async function loadUnitedFlights(page, search, { now = Date.now } = {}) {
  // A fresh document prevents the SPA from reusing the preceding route or award mode.
  await page.goto("about:blank");
  await page.goto(buildSearchUrl(search));
  const deadline = now() + search.timeout * 1000;
  let previous = "";
  let expanded = false;
  let expectedTotal = null;
  while (now() <= deadline) {
    const data = await page.evaluate(readUnitedPage);
    const total = data.displayed[1];
    // The counter can disappear during expansion. Its highest total remains the completion bound.
    if (Number.isInteger(total) && total > 0) expectedTotal = Math.max(expectedTotal ?? 0, total);
    if (data.challenge)
      throw new Error("United served an access challenge. Clear it in the browser, then retry");
    if (data.service_error) throw new Error("United could not complete this search. Retry later");
    if (data.login_required) {
      throw new UnitedLoginRequiredError(
        "Sign in to MileagePlus on united.com in this browser, then retry --miles. Cash prices will not be substituted",
      );
    }
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
