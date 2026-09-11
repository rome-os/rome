import { assertSearchPage, buildSearchUrl } from "./southwest-helpers.mjs";
import { readSouthwestPage } from "./southwest-page.mjs";

export class SouthwestLoginRequiredError extends Error {}

/** Reads a fresh search. Never clicks a fare, changes account state, or creates a booking. */
export async function loadSouthwestFlights(page, search, { now = Date.now } = {}) {
  const deadline = now() + search.timeout * 1000;
  await page.goto("about:blank");
  await page.goto(buildSearchUrl(search));
  let previous = "";
  let expected = null;
  while (now() <= deadline) {
    const data = await page.evaluate(readSouthwestPage);
    if (data.challenge)
      throw new Error("Southwest served an access challenge. Clear it in the browser, then retry");
    if (data.login_required)
      throw new SouthwestLoginRequiredError(
        "Log in to Rapid Rewards on southwest.com in this browser, then retry. Cash fares will not be substituted",
      );
    if (data.error && !data.no_results)
      throw new Error(`Southwest could not complete the search: ${data.error}`);
    const currentUrl = new URL(data.url);
    if (
      currentUrl.pathname === "/air/booking/" &&
      currentUrl.searchParams.get("validate") === "true"
    )
      throw new Error(
        "Southwest rejected these search conditions. Check the airport codes, travel dates, and passenger count in the browser",
      );
    if (data.ready && Number.isInteger(data.expected_count))
      expected = Math.max(expected ?? 0, data.expected_count);
    if (data.ready && !data.loading) {
      assertSearchPage(data, search);
      const complete =
        expected !== null && data.rows.length === expected && (expected > 0 || data.no_results);
      const signature = complete ? JSON.stringify(data) : "";
      if (signature && signature === previous) return { ...data, expected_count: expected };
      previous = signature;
    } else previous = "";
    await page.wait({ time: 1 });
  }
  throw new Error(
    `Southwest did not finish loading all flights within ${search.timeout}s. Retry or increase --timeout. No partial prices were returned`,
  );
}
