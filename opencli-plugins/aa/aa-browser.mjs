import { assertSearchPage, buildSearchUrl } from "./aa-helpers.mjs";
import { readAaPage } from "./aa-page.mjs";

export class AaLoginRequiredError extends Error {}

/** Reads a fresh search without selecting a fare, accessing auth storage, or creating a booking. */
export async function loadAaFlights(page, search, { now = Date.now } = {}) {
  const deadline = now() + search.timeout * 1000;
  await page.goto("about:blank");
  await page.goto(buildSearchUrl(search));
  let previous = "";
  let expected = null;
  while (now() <= deadline) {
    let data;
    try {
      data = await page.evaluate(readAaPage);
    } catch (error) {
      if (
        !/execution context was destroyed|cannot find context with specified id/i.test(
          error.message,
        )
      )
        throw error;
      previous = "";
      await page.wait({ time: 1 });
      continue;
    }
    if (data.challenge)
      throw new Error("AA served an access challenge. Resolve it in the browser, then retry");
    if (data.login_required)
      throw new AaLoginRequiredError(
        "Log in to aa.com in this browser, then retry. Cash fares will not be substituted for miles",
      );
    if (data.expired)
      throw new Error("AA's search session expired. Retry the command to start a new search");
    if (data.error && !data.no_results)
      throw new Error(`AA could not complete the search: ${data.error}`);
    if (data.ready && Number.isInteger(data.expected_count))
      expected = Math.max(expected ?? 0, data.expected_count);
    if (data.ready && !data.loading) {
      const complete =
        expected !== null && data.rows.length === expected && (expected > 0 || data.no_results);
      // AA mounts the results grid before its date controls finish hydrating.
      const hydrated =
        data.search?.depart &&
        data.search?.date_label &&
        (!search.returnDate || data.search?.return_date);
      const signature = complete && hydrated ? JSON.stringify(data) : "";
      if (signature && signature === previous) {
        assertSearchPage(data, search);
        return { ...data, expected_count: expected };
      }
      previous = signature;
    } else previous = "";
    await page.wait({ time: 1 });
  }
  throw new Error(
    `AA did not finish loading the displayed flights within ${search.timeout}s. Retry or increase --timeout. No partial prices were returned`,
  );
}
