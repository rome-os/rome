export function readAaPage() {
  const clean = (v) =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (e) =>
    !!e &&
    e.getClientRects().length > 0 &&
    !e.closest('[hidden], [aria-hidden="true"]') &&
    getComputedStyle(e).visibility !== "hidden";
  const text = (e, selector) => clean(e?.querySelector(selector)?.textContent);
  const visibleText = (e, selector) =>
    clean([...e.querySelectorAll(selector)].find(visible)?.textContent);
  const form = document.querySelector("app-modify-search");
  const matrix = [
    ...document.querySelectorAll("app-results-matrix, app-results-grid-desktop"),
  ].find(visible);
  const body = document.body?.innerText || "";
  let passengers = null;
  try {
    passengers = JSON.parse(
      form?.querySelector("[data-passengers]")?.getAttribute("data-passengers") || "null",
    );
  } catch {}
  const count = text(matrix, ".result-count").match(/^(\d+) results?$/);
  const cards = matrix
    ? [...matrix.querySelectorAll("app-slice-details, .flight-row")].filter(visible)
    : [];
  return {
    origin: location.origin,
    path: location.pathname,
    language: document.documentElement?.lang || "",
    width: window.innerWidth,
    ready: !!matrix,
    challenge:
      /access denied|verify you are human|unusual traffic|pardon our interruption|request (?:has been )?blocked/i.test(
        body,
      ),
    login_required: /\/loyalty\/login/.test(location.pathname),
    expired:
      /session-timeout/.test(location.pathname) || /your session (?:has )?expired/i.test(body),
    error: [
      ...document.querySelectorAll(
        "app-error-notification, app-request-modified-notification, [role=alert]",
      ),
    ]
      .filter(visible)
      .map((e) => clean(e.innerText))
      .filter(Boolean)
      .join(" "),
    no_results:
      /no flights (?:are )?(?:available|found)|we couldn.t find (?:any )?flights|no results (?:found|match)/i.test(
        body,
      ),
    loading: [
      ...document.querySelectorAll(
        "[role=progressbar], [aria-busy=true], mat-spinner, mat-progress-spinner",
      ),
    ].some(visible),
    expected_count: count ? Number(count[1]) : null,
    search: {
      from: form?.querySelector("#matOriginAirport")?.value ?? null,
      to: form?.querySelector("#matDestinationAirport")?.value ?? null,
      depart: form?.querySelector('input[id^="date-input-first-"]')?.value ?? null,
      return_date: form?.querySelector('input[id^="date-input-second-"]')?.value || null,
      miles: form?.querySelector("#redeem-miles")?.checked ?? null,
      trip_type: text(form, 'mat-select[name="tripType"]'),
      passengers,
      header_from: text(form, "app-modify-search-header .origin"),
      header_to: text(form, "app-modify-search-header .destination").replace(/,$/, "").trim(),
      header_passengers: text(form, "app-modify-search-header .passenger-count"),
      direction: text(document, "#flight-direction-text"),
      date_label: text(document, "app-depart-return-header-desktop .date"),
    },
    rows: cards.map((row) => ({
      id: row.id || row.querySelector(".slice-column")?.id || "",
      origin: text(row, ".origin .city-code"),
      destination: text(row, ".destination .city-code"),
      departure: text(row, ".origin .time, .origin .flt-times"),
      arrival: text(row, ".destination .time, .destination .flt-times"),
      duration: text(row, ".duration"),
      stops: text(row, "app-stops-tooltip"),
      segments: [...row.querySelectorAll(".leg-info")].map((e) => ({
        flight_number: text(e, ".flight-number"),
        aircraft: text(e, ".aircraft, .aircraft-name"),
        operator: text(e, "app-operated-by"),
      })),
      alerts: text(row, "app-matrix-slice-alerts") || text(row, ".slice-info .alerts"),
      fares: [...row.querySelectorAll("button.btn-flight")].filter(visible).map((e) => ({
        group: !!e.closest("app-product-groups"),
        name:
          e.getAttribute("data-product") || text(e, ".hidden-product-group, .hidden-product-type"),
        amount: visibleText(e, ".per-pax-amount"),
        addon: visibleText(e, ".per-pax-addon"),
        scope: text(e, ".trip-type"),
        description: text(e, ".a11y-drawer-button-text, .hidden-flight-details"),
        unavailable:
          e.disabled ||
          e.getAttribute("aria-disabled") === "true" ||
          /not available|sold out/i.test(e.innerText),
      })),
    })),
  };
}
