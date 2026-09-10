export const CABINS = [
  "economy",
  "economy-plus",
  "premium-economy",
  "business",
  "first",
  "business-or-first",
  "all",
];
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
  // Departure dates are origin-local. United validates bookability without a guessed airport timezone.
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
  const url = new URL("https://www.united.com/en/us/fsr/choose-flights");
  const params = {
    f: search.from,
    t: search.to,
    d: search.depart,
    px: String(search.adults),
    tqp: search.miles ? "A" : "R",
    sc: search.returnDate ? "7,7" : "7",
    clm: "7",
    taxng: "1",
    newHP: "True",
    st: "bestmatches",
  };
  // `at=1` selects award travel, not the adult count. Cash links omit `at`.
  if (search.miles) params.at = "1";
  if (search.returnDate) params.r = search.returnDate;
  else params.tt = "1";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Validate the loaded search before attaching the requested route/date to any price. */
export function assertSearchPage(data, search) {
  const url = new URL(data.url);
  const params = url.searchParams;
  if (
    url.hostname !== "www.united.com" ||
    url.pathname.toLowerCase() !== "/en/us/fsr/choose-flights"
  ) {
    throw new Error("United did not open its English-US flight results page");
  }
  const expected = { f: search.from, t: search.to, d: search.depart, px: String(search.adults) };
  for (const [name, value] of Object.entries(expected)) {
    if (params.get(name) !== value)
      throw new Error(`United changed the requested ${name} search condition`);
  }
  if (
    (params.get("r") || null) !== search.returnDate ||
    (params.get("idx") && params.get("idx") !== "1")
  ) {
    throw new Error("United is not showing the requested outbound search");
  }
  if (
    (params.get("at") === "1") !== search.miles ||
    data.price_mode !== (search.miles ? "miles" : "money")
  ) {
    throw new Error("United did not honor the requested money/miles mode. No prices were returned");
  }
  if (!/^en(?:-|$)/i.test(data.language) || data.currency !== "USD") {
    throw new Error(
      "Set United's locale to English - United States and currency to USD, then retry",
    );
  }
  if (!new RegExp(`^${search.adults} Adults?$`).test(data.traveler_text)) {
    throw new Error("United did not show the requested adult traveler count");
  }
  if (data.no_results && data.rows.length === 0) return;
  const month = new Date(`${search.depart}T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const heading = new RegExp(`^Depart on:\\s*${month} ${Number(search.depart.slice(8))}$`, "i");
  if (!heading.test(data.date_heading))
    throw new Error("United did not show the requested departure date heading");
}

export function parseMoney(value) {
  const match = String(value || "")
    .trim()
    .match(/^(?:US\s*)?\$\s*(\d+(?:,\d{3})*)(?:\.(\d{2}))?$/);
  return match ? Number(`${match[1].replaceAll(",", "")}.${match[2] || "00"}`) : null;
}

/** Converts the displayed value only. A rounded `13.5k` label remains available in the output. */
export function parseMiles(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+(?:,\d{3})*(?:\.\d+)?)\s*([km])?(?:\s*miles)?$/i);
  if (!match) return null;
  const number =
    Number(match[1].replaceAll(",", "")) * ({ k: 1000, m: 1000000 }[match[2]?.toLowerCase()] || 1);
  const rounded = Math.round(number);
  return Number.isSafeInteger(rounded) && Math.abs(number - rounded) < 1e-7 ? rounded : null;
}

export function cabinOf(product) {
  if (/premium plus|premium economy/i.test(product)) return "premium-economy";
  if (/economy plus/i.test(product)) return "economy-plus";
  if (/polaris|business/i.test(product)) return "business";
  if (/first/i.test(product)) return "first";
  if (/economy/i.test(product)) return "economy";
  return "unknown";
}

export function timeMinutes(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2]) > 59) return null;
  return (Number(match[1]) % 12) * 60 + Number(match[2]) + (/PM/i.test(match[3]) ? 720 : 0);
}

export function dateFromNote(note, baseDate) {
  if (!note?.trim()) return baseDate;
  const match = note.trim().match(/^(?:Departs|Arrives) ([A-Z][a-z]{2}) (\d{1,2})$/);
  const month = match
    ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(
        match[1],
      )
    : -1;
  if (month < 0) throw new Error(`Unrecognized United date label: ${note}`);
  const year = Number(baseDate.slice(0, 4));
  const base = Date.parse(`${baseDate}T00:00:00Z`);
  const candidates = [year - 1, year, year + 1]
    .map((candidate) => new Date(Date.UTC(candidate, month, Number(match[2]))))
    .filter(
      (candidate) =>
        candidate.getUTCMonth() === month && Math.abs(candidate.getTime() - base) <= 7 * 86400000,
    )
    .sort((a, b) => Math.abs(a.getTime() - base) - Math.abs(b.getTime() - base));
  if (!candidates.length) throw new Error(`United date label is outside this itinerary: ${note}`);
  return candidates[0].toISOString().slice(0, 10);
}

export function priceBasis(note) {
  if (/round\s*-?\s*trip.*per person/i.test(note)) return "round_trip_per_person_starting_total";
  if (/one-way.*per person/i.test(note)) return "one_way_per_person";
  return "displayed_price_see_fare_note";
}

/** One output row per flight and fare column, never calendar prices or crossed-out award prices. */
export function normalizeResults(data, search, retrievedAt = new Date().toISOString()) {
  assertSearchPage(data, search);
  const results = [];
  for (const [index, flight] of data.rows.entries()) {
    if (flight.origin !== search.from || flight.destination !== search.to)
      throw new Error("United returned a flight for a different route");
    const departureDate = dateFromNote(flight.departure_note, search.depart);
    if (departureDate !== search.depart) continue;
    const arrivalDate = dateFromNote(flight.arrival_note, departureDate);
    const stopsMatch = flight.flight_text.match(/\b(\d+)\s+STOPS?\b/i);
    const stops = /\bNONSTOP\b/i.test(flight.flight_text)
      ? 0
      : stopsMatch
        ? Number(stopsMatch[1])
        : null;
    const duration = flight.duration_text.match(/(?:(\d+)\s*H[,\s]*)?(\d+)\s*M/i);
    const durationMinutes = duration ? Number(duration[1] || 0) * 60 + Number(duration[2]) : null;
    if (
      stops === null ||
      durationMinutes === null ||
      timeMinutes(flight.departure) === null ||
      timeMinutes(flight.arrival) === null
    ) {
      throw new Error(
        "United flight timing or stop labels changed. No partial results were returned",
      );
    }
    if (!flight.fares.length) throw new Error("United exposed a flight without fare columns");
    for (const fare of flight.fares) {
      if (/^(?:not available|unavailable|sold out|not offered)$/i.test(fare.text.trim())) continue;
      if (!fare.product) throw new Error("United fare column label is missing");
      const cash = parseMoney(fare.money_text);
      const miles = parseMiles(fare.miles_text);
      if (
        search.miles ? miles === null || cash === null : cash === null || Boolean(fare.miles_text)
      ) {
        throw new Error(
          "United fare price format or money/miles mode changed. No partial results were returned",
        );
      }
      const cabin = cabinOf(fare.product);
      const mixedCabin =
        /mixed cabin/i.test(`${fare.cabin} ${fare.text}`) ||
        (fare.cabin.match(/United (?:Economy|First|Business|Polaris|Premium Plus)/g) || []).length >
          1;
      const maxStops = { any: Infinity, nonstop: 0, "one-or-fewer": 1, "two-or-fewer": 2 }[
        search.stops
      ];
      const cabinMatches =
        search.cabin === "all" ||
        cabin === search.cabin ||
        (search.cabin === "business-or-first" && ["business", "first"].includes(cabin));
      if (
        !cabinMatches ||
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
        origin: flight.origin,
        destination: flight.destination,
        departure_date: departureDate,
        departure: flight.departure,
        arrival_date: arrivalDate,
        arrival: flight.arrival,
        duration_minutes: durationMinutes,
        stops,
        flight_numbers: [
          ...new Set(
            [...flight.flight_text.matchAll(/Flight Number ([A-Z0-9]{2,3}\s*\d+)\./g)].map(
              (match) => match[1],
            ),
          ),
        ],
        cabin,
        fare_product: fare.product,
        cabin_details: fare.cabin,
        mixed_cabin: mixedCabin,
        price: search.miles ? null : cash,
        miles: search.miles ? miles : null,
        taxes: search.miles ? cash : null,
        currency: "USD",
        price_text: search.miles
          ? `${fare.miles_text} miles + ${fare.money_text}`
          : fare.money_text,
        price_basis: priceBasis(data.fare_note),
        fare_note: data.fare_note,
        is_starting_price: /\bFrom\b/i.test(fare.text),
        award_type: fare.award_type,
        discount: fare.discount,
        adults: search.adults,
        return_date: search.returnDate,
        flight_details: flight.flight_text,
        url: buildSearchUrl(search),
        retrieved_at: retrievedAt,
      });
    }
  }
  const orderPrice = (a, b) =>
    search.miles ? a.miles - b.miles || a.taxes - b.taxes : a.price - b.price;
  const sorts = {
    best: () => 0,
    price: orderPrice,
    duration: (a, b) => a.duration_minutes - b.duration_minutes || orderPrice(a, b),
    departure: (a, b) => timeMinutes(a.departure) - timeMinutes(b.departure) || orderPrice(a, b),
  };
  return results
    .sort(sorts[search.sort])
    .slice(0, search.limit)
    .map((row, index) => ({ rank: index + 1, ...row }));
}
