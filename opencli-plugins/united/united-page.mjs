/** Serialized into the browser. Returns flight data and status flags, not account or auth state. */
export function readUnitedPage() {
  const text = (element) => (element?.textContent || "").replace(/\s+/g, " ").trim();
  const get = (element, selector) => text(element.querySelector(selector));
  const body = document.body?.innerText || "";
  const visible = (element) => !!element.getClientRects().length;
  const flightRows = [...document.querySelectorAll('[role="row"]')].filter((element) =>
    element.querySelector('[class*="FlightInfoBlock-styles__departTime--"]'),
  );
  const priceMode = [...document.querySelectorAll("select")].find((element) =>
    [...element.options].some((option) => option.value === "miles"),
  );
  const rows = flightRows.map((row) => {
    const info = row.querySelector('[role="gridcell"]');
    const time = (name) =>
      get(row, `[class*="FlightInfoBlock-styles__${name}Time--"] [class*="__time--"]`);
    const dateNote = (name) =>
      get(row, `[class*="FlightInfoBlock-styles__${name}Time--"] [class*="__specialMsg--"]`);
    const airport = (name) =>
      (row.querySelector(`[class*="FlightInfoBlock-styles__${name}Airport--"]`)?.innerText || "")
        .trim()
        .split(/\s/)[0];
    return {
      departure: time("depart"),
      arrival: time("arrival"),
      departure_note: dateNote("depart"),
      arrival_note: dateNote("arrival"),
      origin: airport("depart"),
      destination: airport("arrival"),
      duration_text: get(row, '[class*="FlightInfoBlock-styles__duration--"]'),
      flight_text: info?.innerText || "",
      fares: [...row.querySelectorAll('[role="gridcell"][aria-describedby]')].map((cell) => ({
        product_id: cell.getAttribute("aria-describedby"),
        product:
          text(document.getElementById(cell.getAttribute("aria-describedby"))) ||
          get(cell, '[class*="PriceCard-styles__cabinTitle--"]'),
        miles_text: get(
          cell,
          '[class*="PriceCard-styles__milesContainer--"] [class*="PriceCard-styles__priceValue--"]',
        ),
        money_text: get(
          cell,
          '[class*="PriceCard-styles__moneyContainer--"] [class*="PriceCard-styles__priceValue--"]',
        ),
        cabin: get(cell, '[class*="PriceCard-styles__cabinDescription--"]'),
        award_type: get(cell, '[class*="PriceCard-styles__discountLabel--"]'),
        discount: get(cell, '[data-test-id="strikeThroughTag"]'),
        text: cell.innerText || "",
      })),
    };
  });
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  return {
    url: location.href,
    language: document.documentElement.lang,
    currency: [...document.querySelectorAll("button[aria-label]")].some((element) =>
      /Currently in English (?:US|United States)\s*\$/.test(element.getAttribute("aria-label")),
    )
      ? "USD"
      : null,
    price_mode: priceMode?.value || null,
    traveler_text: document.querySelector('input[type="button"]')?.value || "",
    date_heading: get(document, '[class*="FlightSearchResultsContainer-styles__detailHeading--"]'),
    fare_note: get(document, '[class*="FareDisclaimer-styles__disclaimer--"]'),
    loading: /Loading results\.\.\./i.test(body),
    service_error: [...document.querySelectorAll('[role="alert"]')].some((element) =>
      /unable to complete your request|please try again later/i.test(element.innerText || ""),
    ),
    login_required: dialogs.some((dialog) =>
      /Email or MileagePlus|must be signed-in to see flight results with miles/i.test(
        dialog.innerText || "",
      ),
    ),
    challenge:
      /Access Denied|verify (?:that )?you are human|unusual traffic|Press & Hold|Your access to this site has been blocked/i.test(
        body,
      ),
    no_results:
      /(?:no flights (?:are )?(?:available|found)|could(?:n['’]t| not) find any flights|unable to find (?:any )?flights|no flights match)/i.test(
        body,
      ),
    show_all: [...document.querySelectorAll("button")].some(
      (button) => visible(button) && /^Show all flights$/i.test(text(button)) && !button.disabled,
    ),
    displayed: (body.match(/Displaying\s+(\d+)\s+of\s+(\d+)/i) || []).slice(1).map(Number),
    rows,
  };
}
