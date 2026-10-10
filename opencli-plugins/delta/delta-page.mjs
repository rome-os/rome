export function readDeltaPage() {
  const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
  const visible = (e) => {
    if (!e || !e.getClientRects().length) return false;
    for (let node = e; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility)
      )
        return false;
    }
    return true;
  };
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const get = (root, selector) => text(all(root, selector)[0]);
  const body = document.body?.innerText || "";
  const key = new URL(location.href).searchParams.get("cacheKeySuffix");
  let search = null;
  // This one key contains the submitted flight search, not the session or account state.
  if (/^[a-zA-Z0-9-]{1,80}$/.test(key || "")) {
    try {
      const s = JSON.parse(localStorage.getItem(`postData${key}`) || "null");
      if (s)
        search = {
          trip_type: s.tripType,
          segments: s.segments?.map((x) => ({
            origin: x.origin,
            destination: x.destination,
            departure_date: x.departureDate,
            return_date: x.returnDate || null,
          })),
          passengers: s.passengers?.map((x) => ({ type: x.type, count: x.count })),
          award: s.awardTravel,
          flexible: s.datesFlexible,
          refundable: s.refundableFlightsOnly,
          exclude_basic: s.includeBasicFaresUnchecked,
        };
    } catch {}
  }
  const rows = all(document, '[id^="flight-results-grid-"]').map((row) => {
    const line = all(row, 'idp-mach-core-flight-card-layover[variant="detailed"]')[0];
    return {
      id: row.id,
      route_label: line?.querySelector('[role="group"]')?.getAttribute("aria-label") || "",
      departure: get(line || row, ".flight-line__times-origin"),
      arrival: get(line || row, ".flight-line__times-destination"),
      arrival_note: get(line || row, '[aria-label^="Confirmed:"]'),
      stop_labels: line
        ? all(line, '[aria-label^="Layover at"]').map((e) =>
            e.getAttribute("aria-label").replace(/\s+/g, " ").trim(),
          )
        : [],
      nonstop: line
        ? /^Nonstop$/i.test(text(line.querySelector(".flight-stop__leg--nonstop")))
        : false,
      duration_text:
        all(row, '[data-testid="flight-card-header-duration"]').map(text).find(Boolean) || "",
      flight_numbers: all(row, '[data-analytics-id="flight-card-number-link"]').map(
        (e) => text(e).match(/^[A-Z0-9]{2}\s*\d+/)?.[0] || "",
      ),
      flight_details: all(row, "idp-mach-core-flight-card")[0]?.innerText || "",
      fares: all(row, "idp-fare-cell-desktop").map((cell, columnIndex) => {
        const box = cell.querySelector('[id*="-fare-cell-desktop-"]');
        const id = box?.id.split("-fare-cell-desktop-")[1] || "";
        const award = all(cell, "idp-fare-cell-miles-template")[0];
        const promo = all(cell, "idp-cobrand-promotional-price")[0];
        return {
          product_id: id,
          column: text(
            document.querySelector(`[data-testid="cabin-header-desktop-name-${columnIndex}"]`),
          ),
          products: all(cell, "[data-analytics-cabin]").map((e) => text(e).replace(/,\s*$/, "")),
          cash_text: get(cell, "idp-fare-cell-revenue-template"),
          miles_text: award ? get(award, ".miles-value") : "",
          taxes_text: award ? get(award, ".tax-container") : "",
          promo_text: text(promo),
          promo_label: get(cell, ".cobrand-badge__label"),
          trip_type: get(cell, ".fare-cell-trip-type"),
          text: cell.innerText || "",
        };
      }),
    };
  });
  const dialogs = all(document, 'dialog[open], [role="dialog"]').map((e) => e.innerText || "");
  const alerts = all(document, '[role="alert"]')
    .map((e) => e.innerText || "")
    .join(" ");
  const formButton = all(document, 'button[id="findFilghtsCta"]')[0];
  const count = [...document.querySelectorAll(".results-label")]
    .map(text)
    .join(" ")
    .match(/([\d,]+) Flight Results?/i);
  return {
    url: location.href,
    language: document.documentElement.lang,
    locale: get(document, "idp-language-selector"),
    search,
    form_ready: visible(formButton),
    price_mode: get(document, 'idp-show-price-in-tabs [aria-selected="true"]'),
    leg: get(document, '[data-testid="flight-context-info-label"]'),
    route_text: get(document, '[data-testid="flight-context-info-airport-codes"]'),
    date_heading: get(document, '[data-testid="flight-context-info-date"]'),
    traveler_text: get(document, "#mach-core-header-nav-slim-passenger"),
    fare_note: get(document, '[data-testid="flight-context-info-price-disclaimer"]'),
    total: count ? Number(count[1].replaceAll(",", "")) : null,
    more: all(document, "button").some((e) => /^See More Results$/i.test(text(e))),
    desktop: rows.length ? rows.every((r) => r.fares.length > 0) : true,
    loading:
      all(document, '[role="progressbar"], [aria-busy="true"]').length > 0 ||
      /Searching for flights|Loading results/i.test(body),
    challenge:
      /Access Denied|verify (?:that )?you are human|unusual traffic|Press & Hold|access to this site has been blocked/i.test(
        body,
      ),
    service_error:
      /unable to (?:process|complete)|technical difficulties|try again later|session (?:has )?(?:timed out|expired)|search (?:has )?expired/i.test(
        `${alerts} ${dialogs.join(" ")}`,
      ),
    login_required: dialogs.some((t) => /log in|sign in/i.test(t) && /SkyMiles|password/i.test(t)),
    no_results:
      /no flights (?:are )?(?:available|found)|no (?:matching )?flights match|could(?:n['’]t| not) find (?:any )?flights|no results found/i.test(
        `${alerts} ${document.querySelector("idp-search-results")?.innerText || ""}`,
      ),
    rows,
  };
}
