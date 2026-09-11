const AIRPORT_CODE = /^[a-z]{3}$/i;

// A leading airport code opts into list syntax. Commas in city names remain text.
export function parseFlightLocation(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} must not be empty`);
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length === 1 || (parts[0] !== "" && !AIRPORT_CODE.test(parts[0]))) {
    return { query: text, airports: null };
  }
  if (!parts.every((part) => AIRPORT_CODE.test(part))) {
    throw new Error(
      `${name} airport lists must contain only comma-separated three-letter airport codes`,
    );
  }
  const airports = [...new Set(parts.map((part) => part.toUpperCase()))];
  if (airports.length > 7) throw new Error(`${name} supports at most 7 distinct airports`);
  return { query: airports[0], airports };
}

// Runs in the page. Keep every DOM dependency inside this function for OpenCLI serialization.
export function flightAirportPicker({ side, action, code }) {
  const visible = (element) =>
    element &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  const label = side === "origin" ? "Where from?" : "Where to?";
  const dialog = document.querySelector(`[role="dialog"][aria-label="Enter your ${side}"]`);
  const chips = () =>
    Array.from(dialog?.querySelectorAll("div[data-code]") || []).filter((element) =>
      element.querySelector('[aria-label="Remove"]'),
    );
  if (action === "read") {
    return dialog ? chips().map((element) => element.getAttribute("data-code")) : null;
  }
  if (action === "open") {
    const input = Array.from(document.querySelectorAll("input[aria-label]")).find(
      (element) => element.getAttribute("aria-label").startsWith(label) && visible(element),
    );
    if (!input) return false;
    input.click();
    return true;
  }
  if (!visible(dialog)) return false;
  if (action === "enable") {
    const multiple = Array.from(dialog.querySelectorAll("button[aria-label]")).find(
      (element) =>
        element.getAttribute("aria-label").endsWith(", Select multiple airports") &&
        visible(element),
    );
    if (multiple) multiple.click();
    return visible(dialog.querySelector('button[aria-label="Done"]'));
  }
  if (action === "remove") {
    const chip = chips().find((element) => element.getAttribute("data-code") === code);
    if (!chip) return false;
    chip.querySelector('[aria-label="Remove"]').click();
    return true;
  }
  if (action === "type") {
    const input = Array.from(dialog.querySelectorAll('input[role="combobox"]')).find(visible);
    if (!input) return false;
    input.value = code;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (action === "select") {
    const option = Array.from(
      dialog.querySelectorAll(
        'li[data-type="1"][role="option"], li[data-type="1"][role="checkbox"]',
      ),
    ).find((element) => element.getAttribute("data-code") === code && visible(element));
    if (!option) return false;
    option.click();
    return true;
  }
  if (action === "done") {
    const done = dialog.querySelector('button[aria-label="Done"]');
    if (!visible(done)) return false;
    done.click();
    return true;
  }
  throw new Error(`Unknown airport picker action: ${action}`);
}

function sameAirports(actual, expected) {
  return (
    actual && actual.length === expected.length && expected.every((code) => actual.includes(code))
  );
}

export async function configureFlightAirports(page, selections) {
  const step = (side, action, code) =>
    page.evaluate(`(${flightAirportPicker.toString()})(${JSON.stringify({ side, action, code })})`);
  const until = async (read, message) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await read()) return;
      await page.wait(0.2);
    }
    throw new Error(message);
  };
  for (const [side, airports] of Object.entries(selections)) {
    if (!airports) continue;
    const failure = `Could not configure Google Flights ${side} airports: ${airports.join(",")}`;
    await until(() => step(side, "open"), failure);
    await until(() => step(side, "enable"), failure);
    const selected = await step(side, "read");
    if (!selected) throw new Error(failure);
    for (const code of selected.filter((code) => !airports.includes(code))) {
      if (!(await step(side, "remove", code))) throw new Error(failure);
      await until(async () => !(await step(side, "read"))?.includes(code), failure);
    }
    for (const code of airports) {
      if ((await step(side, "read"))?.includes(code)) continue;
      if (!(await step(side, "type", code))) throw new Error(failure);
      await until(
        () => step(side, "select", code),
        `${failure}. Airport ${code} was not selectable`,
      );
      await until(async () => (await step(side, "read"))?.includes(code), failure);
    }
    await until(async () => sameAirports(await step(side, "read"), airports), failure);
    // Done changes the search URL. Submit separately from waits in the page context.
    if (!(await step(side, "done"))) throw new Error(failure);
    await page.wait(0.5);
  }
}

// Check the committed, reloaded search, not the transient chips in an open picker.
export async function verifyFlightAirports(page, selections) {
  for (const [side, airports] of Object.entries(selections)) {
    if (!airports) continue;
    const actual = await page.evaluate(
      `(${flightAirportPicker.toString()})(${JSON.stringify({ side, action: "read" })})`,
    );
    if (!sameAirports(actual, airports)) {
      throw new Error(
        `Google Flights did not retain the requested ${side} airports: ${airports.join(",")}`,
      );
    }
  }
}
