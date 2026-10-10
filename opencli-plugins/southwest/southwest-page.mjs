// Only the flight-matrix and row component props are read. Account state stays untouched.
export function readSouthwestPage() {
  const visible = (e) => {
    if (!e || !e.getClientRects().length || e.closest('[hidden], [aria-hidden="true"]'))
      return false;
    const style = getComputedStyle(e);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
  const one = (root, selector) => [...root.querySelectorAll(selector)].find(visible);
  const component = (element, required) => {
    let fiber = element?.[Object.keys(element || {}).find((k) => k.startsWith("__reactFiber$"))];
    for (let i = 0; fiber && i < 8; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && required.every((k) => Object.hasOwn(props, k))) return props;
    }
    return null;
  };
  const matrix = one(document, ".air-booking-select-price-matrix");
  const props = component(matrix, ["searchQuery", "availableFlights", "loading"]);
  // Southwest omits details on its confirmed empty-results matrix.
  const noResults =
    props?.hasNoFlightsAvailableError === true &&
    props.loading === false &&
    props.availableFlights === 0 &&
    (Array.isArray(props.details)
      ? props.details.length === 0
      : !Object.hasOwn(props, "details") && props.totalResults === 0);
  const fields = [
    "adultPassengersCount",
    "adultsCount",
    "departureDate",
    "departureTimeOfDay",
    "destinationAirportCode",
    "fareType",
    "originationAirportCode",
    "passengerType",
    "promoCode",
    "returnDate",
    "returnTimeOfDay",
    "tripType",
    "lapInfantPassengersCount",
  ];
  const search = props
    ? Object.fromEntries(fields.map((k) => [k, props.searchQuery?.[k] ?? null]))
    : null;
  const rows = matrix
    ? [...matrix.querySelectorAll(".air-booking-select-detail")].filter(visible).map((e) => {
        const p = component(e, [
          "departureDateTime",
          "arrivalDateTime",
          "stopsDetails",
          "flightNumbers",
        ]);
        return {
          id: e.getAttribute("data-test"),
          origin: p?.originationAirportCode ?? null,
          destination: p?.destinationAirportCode ?? null,
          departure_at: p?.departureDateTime ?? null,
          arrival_at: p?.arrivalDateTime ?? null,
          duration_minutes: p?.totalDuration ?? null,
          flight_numbers: Array.isArray(p?.flightNumbers) ? p.flightNumbers.map(String) : null,
          segments: Array.isArray(p?.stopsDetails)
            ? p.stopsDetails.map((s) => ({
                origin: s.originationAirportCode,
                destination: s.destinationAirportCode,
                departure_at: s.departureDateTime,
                arrival_at: s.arrivalDateTime,
                flight_number: s.flightNumber,
                change_planes: s.changePlanes,
                stop_minutes: s.stopDuration,
                duration_minutes: s.legDuration,
                operating_carrier: s.operatingCarrierCode,
                marketing_carrier: s.marketingCarrierCode,
              }))
            : null,
          departure_text: text(
            one(e, '[data-test="select-detail--origination-time"] .time--value'),
          ),
          arrival_text: text(one(e, '[data-test="select-detail--destination-time"] .time--value')),
          stops_text: text(one(e, ".flight-stops-badge")),
          duration_text: text(one(e, ".select-detail--flight-duration")),
          fares: [...e.querySelectorAll(".fare-button[data-test]")].filter(visible).map((f) => {
            const button = one(f, ".fare-button--button");
            return {
              product: f.getAttribute("data-test").replace(/^fare-button--/, ""),
              label: button?.getAttribute("aria-label") || "",
              unavailable:
                !button ||
                button.disabled ||
                button.getAttribute("aria-disabled") === "true" ||
                f.classList.contains("fare-button_disabled"),
              amount_text: text(one(f, ".currency .swa-g-screen-reader-only")),
              points: !!one(f, ".currency_points"),
              taxes_text: text(one(f, ".taxes-text")),
              seats_text:
                (button?.getAttribute("aria-label") || "").match(/\d+ seats? left/i)?.[0] || "",
            };
          }),
        };
      })
    : [];
  const selectedEpoch =
    matrix && one(matrix, '.calendar-strip [aria-current="true"]')?.getAttribute("itemday");
  const selectedDay = selectedEpoch ? new Date(Number(selectedEpoch)) : null;
  const selectedDate =
    selectedDay && Number.isFinite(selectedDay.getTime())
      ? [
          selectedDay.getFullYear(),
          String(selectedDay.getMonth() + 1).padStart(2, "0"),
          String(selectedDay.getDate()).padStart(2, "0"),
        ].join("-")
      : null;
  const error = text(one(document, ".page-error"));
  const body = document.body?.innerText || "";
  return {
    url: location.href,
    language: document.documentElement.lang,
    ready: !!props,
    loading: props?.loading ?? true,
    expected_count: Array.isArray(props?.details) ? props.details.length : noResults ? 0 : null,
    available_count: props?.availableFlights ?? null,
    search,
    route_text: text(matrix && one(matrix, ".price-matrix--airport-codes")),
    selected_date: selectedDate,
    price_mode: matrix
      ? (one(matrix, '[data-test^="currency-options-toggle-item--"].swa-g-selected')
          ?.getAttribute("data-test")
          ?.replace("currency-options-toggle-item--", "") ?? null)
      : null,
    fare_note:
      [...document.querySelectorAll(".search-results--terms li")]
        .map(text)
        .find((t) => /per person for each way/i.test(t)) || "",
    rounding_note: matrix ? text(one(matrix, ".air-booking-select-price-heading-options")) : "",
    error,
    challenge:
      /access denied|verify you are human|are you a robot|unusual traffic|press.{0,5}hold/i.test(
        document.title + " " + body.slice(0, 1500),
      ),
    login_required:
      /log in.*(?:search|view).*(?:points|fares)|sign in.*(?:search|view).*(?:points|fares)/i.test(
        error,
      ),
    no_results: noResults,
    rows,
  };
}
