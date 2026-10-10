import { assertSearchPage } from "./delta-helpers.mjs";
import { assertDeltaAvailable, DELTA_HOME, submitDeltaSearch } from "./delta-form.mjs";
import { readDeltaPage } from "./delta-page.mjs";
export { DeltaLoginRequiredError } from "./delta-form.mjs";

export function expandMoreFlights() {
  const button = [...document.querySelectorAll("button")].find(
    (e) =>
      /^See More Results$/i.test(e.textContent.trim()) && e.getClientRects().length && !e.disabled,
  );
  if (!button) return false;
  button.click();
  return true;
}

/** Submits homepage controls and expands results. Never selects a fare or creates a booking. */
export async function loadDeltaFlights(
  page,
  search,
  { now = Date.now, submit = submitDeltaSearch } = {},
) {
  await page.goto(DELTA_HOME);
  // Date-picker animations and native controls require the adapter-owned tab to be active.
  await page.selectTab(0);
  await submit(page, search, { now });
  const deadline = now() + search.timeout * 1000;
  let expectedTotal = null;
  let expandedAt = -1;
  let previous = "";
  while (now() <= deadline) {
    const data = await page.evaluate(readDeltaPage);
    assertDeltaAvailable(data);
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
