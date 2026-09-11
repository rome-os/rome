export const CABINS = ["economy", "comfort", "premium-economy", "business", "first", "all"];
export const SORTS = ["best", "price", "duration", "departure"];
export const STOPS = ["any", "nonstop", "one-or-fewer", "two-or-fewer"];

function integer(value, name, min, max) {
  const number = Number(value);
  if (
    typeof value === "boolean" ||
    value === null ||
    String(value).trim() === "" ||
    !Number.isInteger(number) ||
    number < min ||
    number > max
  ) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function positive(value, name) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (typeof value === "boolean" || !Number.isFinite(number) || number <= 0)
    throw new Error(`${name} must be positive`);
  return number;
}

function date(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`${name} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid calendar date`);
  }
  return value;
}

function choice(value, name, values) {
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

export function normalizeSearch(args) {
  const airport = (value, name) => {
    const code = String(value || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(code))
      throw new Error(`${name} must be a three-letter airport code, such as SFO`);
    return code;
  };
  const from = airport(args.from, "from");
  const to = airport(args.to, "to");
  if (from === to) throw new Error("from and to must be different airports");
  const depart = date(args.depart, "depart");
  const returnDate = args.return === undefined ? null : date(args.return, "return");
  // Departure dates are origin-local. Delta validates bookability without a guessed airport timezone.
  if (returnDate && returnDate < depart) throw new Error("return must be on or after depart");
  if (args.miles !== undefined && typeof args.miles !== "boolean")
    throw new Error("miles must be a boolean flag");
  if (args["exclude-mixed-cabin"] !== undefined && typeof args["exclude-mixed-cabin"] !== "boolean")
    throw new Error("exclude-mixed-cabin must be a boolean flag");
  const miles = args.miles ?? false;
  const maxPrice = positive(args["max-price"], "max-price");
  const maxMiles =
    args["max-miles"] === undefined ? null : integer(args["max-miles"], "max-miles", 1, 10000000);
  if (miles && maxPrice !== null)
    throw new Error("Use --max-miles for award prices, not --max-price");
  if (!miles && maxMiles !== null) throw new Error("--max-miles requires --miles");
  return {
    from,
    to,
    depart,
    returnDate,
    miles,
    maxPrice,
    maxMiles,
    adults: integer(args.adults ?? 1, "adults", 1, 9),
    cabin: choice(args.cabin ?? "economy", "cabin", CABINS),
    stops: choice(args.stops ?? "any", "stops", STOPS),
    sort: choice(args.sort ?? "best", "sort", SORTS),
    limit: integer(args.limit ?? 20, "limit", 1, 500),
    timeout: integer(args.timeout ?? 90, "timeout", 5, 180),
    maxDuration:
      args["max-duration"] === undefined
        ? null
        : integer(args["max-duration"], "max-duration", 1, 10080),
    excludeMixed: args["exclude-mixed-cabin"] ?? false,
  };
}

export function buildSearchUrl(search) {
  const url = new URL("https://www.delta.com/flightsearch/book-a-flight");
  const params = {
    tripType: search.returnDate ? "ROUND_TRIP" : "ONE_WAY",
    originCity: search.from,
    destinationCity: search.to,
    departureDate: search.depart,
    paxCount: String(search.adults),
    awardTravel: String(search.miles),
    cabinFareClass: "BE",
    searchByCabin: "true",
    priceSchedule: "price",
  };
  if (search.returnDate) params.returnDate = search.returnDate;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function assertSearchPage(data, search) {
  const url = new URL(data.url);
  if (url.hostname !== "www.delta.com" || url.pathname !== "/flightsearch/search-results")
    throw new Error("Delta did not open its flight results page");
  const submitted = data.search;
  const segment = submitted?.segments?.[0];
  if (
    submitted?.segments?.length !== 1 ||
    segment?.origin !== search.from ||
    segment?.destination !== search.to ||
    segment?.departure_date !== search.depart ||
    segment?.return_date !== search.returnDate ||
    submitted.trip_type !== (search.returnDate ? "ROUND_TRIP" : "ONE_WAY") ||
    submitted.passengers?.length !== 1 ||
    submitted.passengers[0].type !== "ADT" ||
    Number(submitted.passengers[0].count) !== search.adults ||
    submitted.flexible !== false ||
    submitted.refundable !== false ||
    submitted.exclude_basic !== false
  )
    throw new Error(
      "Delta did not preserve the requested route, dates, passengers, or search options",
    );
  if (
    String(submitted.award) !== String(search.miles) ||
    data.price_mode !== (search.miles ? "Miles" : "$USD")
  )
    throw new Error("Delta did not honor the requested cash/miles mode. No prices were returned");
  if (!/^en(?:-|$)/i.test(data.language) || !/^United States - English\b/.test(data.locale))
    throw new Error(
      "Set Delta's locale to United States - English, then retry. Only USD prices are supported",
    );
  if (data.no_results && !data.rows.length) return;
  const dateLabel = new Date(`${search.depart}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (
    data.date_heading !== dateLabel ||
    data.route_text !== `${search.from} ${search.to}` ||
    data.leg !== (search.returnDate ? "Outbound" : "One Way") ||
    !new RegExp(`^${search.adults} Passengers?$`).test(data.traveler_text)
  )
    throw new Error("Delta's displayed search does not match the requested outbound flight");
  if (!data.desktop)
    throw new Error(
      "Delta requires a desktop-width browser (at least 1024px) to show every fare column. Widen the browser and retry",
    );
  if (
    !/per passenger, including taxes and fees/i.test(data.fare_note) ||
    /round-trip/i.test(data.fare_note) !== Boolean(search.returnDate)
  )
    throw new Error("Delta's per-passenger fare scope changed. No prices were returned");
}

export function parseMoney(value) {
  const match = String(value || "")
    .trim()
    .match(/^\+?\s*\$\s*(\d+(?:,\d{3})*)(?:\.(\d{1,2}))?$/);
  return match ? Number(`${match[1].replaceAll(",", "")}.${match[2] || "0"}`) : null;
}

export function parseMiles(value) {
  const match = String(value || "")
    .trim()
    .match(/^(?:Actual Fare\s+)?(\d+(?:,\d{3})*)(?:\s*miles)?$/i);
  if (!match) return null;
  const result = Number(match[1].replaceAll(",", ""));
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function cabinOf(product) {
  if (/premium select/i.test(product)) return "premium-economy";
  if (/comfort/i.test(product)) return "comfort";
  if (/delta one|business/i.test(product)) return "business";
  if (/first/i.test(product)) return "first";
  if (/main|economy/i.test(product)) return "economy";
  return "unknown";
}

export function timeMinutes(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2]) > 59) return null;
  return (Number(match[1]) % 12) * 60 + Number(match[2]) + (/PM/i.test(match[3]) ? 720 : 0);
}

export function arrivalDate(note, depart) {
  if (!note) return depart;
  const match = note.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([A-Z][a-z]{2}) (\d{1,2})$/);
  const month = match
    ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(
        match[1],
      )
    : -1;
  if (month < 0) throw new Error(`Unknown Delta arrival date label: ${note}`);
  const base = Date.parse(`${depart}T00:00:00Z`);
  const year = Number(depart.slice(0, 4));
  for (const y of [year, year + 1, year - 1]) {
    const candidate = new Date(Date.UTC(y, month, Number(match[2])));
    if (candidate.getUTCMonth() === month && Math.abs(candidate.getTime() - base) <= 7 * 86400000)
      return candidate.toISOString().slice(0, 10);
  }
  throw new Error(`Delta arrival date is outside this itinerary: ${note}`);
}

/** Reads displayed prices only. Promotional card-member awards never replace the standard fare. */
export function normalizeResults(data, search, retrievedAt = new Date().toISOString()) {
  assertSearchPage(data, search);
  const results = [];
  const maxStops = { any: Infinity, nonstop: 0, "one-or-fewer": 1, "two-or-fewer": 2 }[
    search.stops
  ];
  const seen = new Set();
  for (const [index, flight] of data.rows.entries()) {
    if (seen.has(flight.id)) throw new Error("Delta returned duplicate flight rows");
    seen.add(flight.id);
    if (flight.route_label !== `Flight from ${search.from} to ${search.to}`)
      throw new Error("Delta returned a flight for a different route");
    const duration = flight.duration_text.match(/^(?:(\d+)h\s*)?(?:(\d+)m)?$/i);
    const durationMinutes = duration ? Number(duration[1] || 0) * 60 + Number(duration[2] || 0) : 0;
    const stops = flight.nonstop ? 0 : flight.stop_labels.length || null;
    if (
      !durationMinutes ||
      stops === null ||
      (flight.nonstop && flight.stop_labels.length) ||
      timeMinutes(flight.departure) === null ||
      timeMinutes(flight.arrival) === null ||
      !flight.flight_numbers.length ||
      flight.flight_numbers.some((n) => !/^[A-Z0-9]{2}\s*\d+$/.test(n))
    )
      throw new Error(
        "Delta flight timing, stops, or flight numbers changed. No partial results were returned",
      );
    const arrival = arrivalDate(flight.arrival_note, search.depart);
    if (!flight.fares.length) throw new Error("Delta exposed a flight without fare columns");
    for (const fare of flight.fares) {
      if (/^(?:Sold Out|Not Offered|Not Available|Unavailable)$/i.test(fare.text.trim())) continue;
      if (!fare.product_id || !fare.column || !fare.products.length)
        throw new Error("Delta fare column labels are missing");
      const cash = parseMoney(fare.cash_text);
      const miles = parseMiles(fare.miles_text);
      const taxes = parseMoney(fare.taxes_text);
      if (
        search.miles
          ? miles === null || taxes === null || Boolean(fare.cash_text)
          : cash === null || Boolean(fare.miles_text || fare.taxes_text)
      )
        throw new Error(
          "Delta fare price format or cash/miles mode changed. No partial results were returned",
        );
      if (fare.trip_type !== (search.returnDate ? "Round Trip" : "One-Way"))
        throw new Error("Delta fare cell does not match the requested trip type");
      const cabins = [...new Set(fare.products.map(cabinOf))];
      if (cabins.includes("unknown"))
        throw new Error(`Unknown Delta cabin: ${fare.products.join(", ")}`);
      const mixedCabin = cabins.length > 1;
      // Mixed-cabin offers match their highest cabin, never masquerade as a cheaper all-economy fare.
      const cabin = [...CABINS].reverse().find((c) => cabins.includes(c));
      let promoMiles = null;
      let promoTaxes = null;
      if (fare.promo_text) {
        const promo = fare.promo_text.match(
          /^(\d+(?:,\d{3})*)\s*\+\s*(\$\s*\d+(?:,\d{3})*(?:\.\d{1,2})?)$/,
        );
        if (!search.miles || !promo || !fare.promo_label)
          throw new Error("Delta promotional award price format changed");
        promoMiles = parseMiles(promo[1]);
        promoTaxes = parseMoney(promo[2]);
        if (promoMiles === null || promoTaxes === null)
          throw new Error("Delta promotional award price is invalid");
      }
      if (
        (search.cabin !== "all" && cabin !== search.cabin) ||
        stops > maxStops ||
        (search.maxDuration !== null && durationMinutes > search.maxDuration) ||
        (search.maxPrice !== null && cash > search.maxPrice) ||
        (search.maxMiles !== null && miles > search.maxMiles) ||
        (search.excludeMixed && mixedCabin)
      )
        continue;
      results.push({
        flight_index: index + 1,
        search_type: search.returnDate ? "round_trip" : "one_way",
        leg: "outbound",
        pricing: search.miles ? "miles" : "money",
        origin: search.from,
        destination: search.to,
        departure_date: search.depart,
        departure: flight.departure,
        arrival_date: arrival,
        arrival: flight.arrival,
        duration_minutes: durationMinutes,
        stops,
        connections: flight.stop_labels,
        flight_numbers: flight.flight_numbers,
        cabin,
        fare_product: fare.products.join(", "),
        fare_column: fare.column,
        mixed_cabin: mixedCabin,
        price: search.miles ? null : cash,
        miles: search.miles ? miles : null,
        taxes: search.miles ? taxes : null,
        currency: "USD",
        price_text: search.miles ? `${fare.miles_text} ${fare.taxes_text}` : fare.cash_text,
        price_basis: search.returnDate
          ? "round_trip_per_passenger_starting_total"
          : "one_way_per_passenger",
        fare_note: data.fare_note,
        is_starting_price: /\bFrom\b/i.test(fare.text),
        card_member_miles: promoMiles,
        card_member_taxes: promoTaxes,
        card_member_offer: fare.promo_label || null,
        adults: search.adults,
        return_date: search.returnDate,
        flight_details: flight.flight_details,
        total_flights: data.total,
        url: buildSearchUrl(search),
        retrieved_at: retrievedAt,
      });
    }
  }
  const priceOrder = (a, b) =>
    search.miles ? a.miles - b.miles || a.taxes - b.taxes : a.price - b.price;
  const sorts = {
    best: () => 0,
    price: priceOrder,
    duration: (a, b) => a.duration_minutes - b.duration_minutes || priceOrder(a, b),
    departure: (a, b) => timeMinutes(a.departure) - timeMinutes(b.departure) || priceOrder(a, b),
  };
  return results
    .sort(sorts[search.sort])
    .slice(0, search.limit)
    .map((row, index) => ({ rank: index + 1, ...row }));
}
