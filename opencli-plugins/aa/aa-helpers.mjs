export const STOPS = ["any", "nonstop", "one-or-fewer", "two-or-fewer"];
export const SORTS = ["best", "price", "duration", "departure"];
export const FARES = [
  "all",
  "main",
  "main-extra",
  "premium-economy",
  "premium",
  "business",
  "first",
];

function integer(value, name, min, max) {
  const n = Number(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    String(value).trim() === "" ||
    !Number.isInteger(n) ||
    n < min ||
    n > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
function date(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`${name} must use YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    throw new Error(`${name} must be a valid calendar date`);
  return value;
}
function choice(value, name, values) {
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}
export function normalizeSearch(args) {
  const airport = (v, name) => {
    const s = String(v || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(s))
      throw new Error(`${name} must be a three-letter airport code, such as SFO`);
    return s;
  };
  const from = airport(args.from, "from");
  const to = airport(args.to, "to");
  if (from === to) throw new Error("from and to must be different airports");
  const depart = date(args.depart, "depart");
  const returnDate = args.return === undefined ? null : date(args.return, "return");
  // AA validates origin-local bookability and its current schedule window.
  if (returnDate && returnDate < depart) throw new Error("return must be on or after depart");
  if (args.miles !== undefined && typeof args.miles !== "boolean")
    throw new Error("miles must be a boolean flag");
  const miles = args.miles ?? false;
  const maxMiles =
    args["max-miles"] === undefined ? null : integer(args["max-miles"], "max-miles", 1, 10000000);
  let maxPrice = null;
  if (args["max-price"] !== undefined) {
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(String(args["max-price"])) ||
      !Number.isFinite(Number(args["max-price"])) ||
      Number(args["max-price"]) <= 0
    )
      throw new Error("max-price must be a positive USD amount");
    maxPrice = Number(args["max-price"]);
  }
  if (miles && maxPrice !== null) throw new Error("Use --max-miles for awards, not --max-price");
  if (!miles && maxMiles !== null) throw new Error("--max-miles requires --miles");
  const fare = choice(args.fare === undefined ? "all" : args.fare, "fare", FARES);
  if (!miles && ["business", "first"].includes(fare))
    throw new Error(
      "Cash results group Business / First under --fare premium. Use --miles for cabin-specific awards",
    );
  if (miles && ["main-extra", "premium"].includes(fare))
    throw new Error(
      "Awards use --fare main, premium-economy, business, or first, not cash fare groups",
    );
  return {
    from,
    to,
    depart,
    returnDate,
    miles,
    maxMiles,
    maxPrice,
    fare,
    adults: integer(args.adults === undefined ? 1 : args.adults, "adults", 1, 9),
    stops: choice(args.stops === undefined ? "any" : args.stops, "stops", STOPS),
    sort: choice(args.sort === undefined ? "best" : args.sort, "sort", SORTS),
    limit: integer(args.limit === undefined ? 20 : args.limit, "limit", 1, 500),
    timeout: integer(args.timeout === undefined ? 90 : args.timeout, "timeout", 5, 180),
    maxDuration:
      args["max-duration"] === undefined
        ? null
        : integer(args["max-duration"], "max-duration", 1, 10080),
  };
}

export function buildSearchUrl(search) {
  const slices = [
    {
      orig: search.from,
      origNearby: false,
      dest: search.to,
      destNearby: false,
      date: search.depart,
    },
  ];
  if (search.returnDate)
    slices.push({
      orig: search.to,
      origNearby: false,
      dest: search.from,
      destNearby: false,
      date: search.returnDate,
    });
  const url = new URL("https://www.aa.com/booking/search/find-flights");
  url.search = new URLSearchParams({
    locale: "en_US",
    fareType: "Lowest",
    pax: String(search.adults),
    adult: String(search.adults),
    type: search.returnDate ? "RoundTrip" : "OneWay",
    searchType: search.miles ? "Award" : "Revenue",
    cabin: "",
    carriers: "ALL",
    travelType: "personal",
    slices: JSON.stringify(slices),
  }).toString();
  return url.toString();
}

export function assertSearchPage(data, search) {
  if (data.origin !== "https://www.aa.com" || data.path !== "/booking/choose-flights/1")
    throw new Error("AA did not open its outbound flight results page");
  if (!/^en(?:-|$)/i.test(data.language))
    throw new Error("Set aa.com to English (United States) and retry");
  if (data.width < 1024)
    throw new Error("AA flight search requires a desktop browser at least 1024px wide");
  const s = data.search;
  const shortDate = (d) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(2, 4)}` : null);
  const dateLabel = new Date(`${search.depart}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const expected = {
    from: search.from,
    to: search.to,
    header_from: search.from,
    header_to: search.to,
    depart: shortDate(search.depart),
    return_date: shortDate(search.returnDate),
    miles: search.miles,
    trip_type: search.returnDate ? "Round trip" : "One way",
    header_passengers: String(search.adults),
    direction: "DEPART",
    date_label: dateLabel,
  };
  for (const [key, value] of Object.entries(expected))
    if (s?.[key] !== value)
      throw new Error(`AA did not preserve the requested search field: ${key}`);
  if (
    !Array.isArray(s.passengers) ||
    s.passengers.length !== 1 ||
    s.passengers[0].type !== "adult" ||
    s.passengers[0].count !== search.adults
  )
    throw new Error("AA did not preserve the requested adult passengers");
}

export function parseMoney(text) {
  const m = String(text).match(/^\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  const amount = m ? Number(`${m[1].replaceAll(",", "")}.${m[2] || "0"}`) : null;
  return Number.isFinite(amount) ? amount : null;
}
export function parseMiles(text) {
  const m = String(text).match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,3}))?([KM])?$/i);
  if (!m) return null;
  const value =
    Number(`${m[1].replaceAll(",", "")}.${m[2] || "0"}`) *
    ({ K: 1000, M: 1000000 }[m[3]?.toUpperCase()] || 1);
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-6 && rounded > 0 ? rounded : null;
}
export function parseClock(text) {
  const m = String(text).match(
    /^(\d{1,2}):(\d{2})\s*(AM|PM)\s*([+-]\d+)?(?:\s*,\s*Arrives on [A-Za-z]+ \d{1,2})?$/,
  );
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return null;
  const hour = (Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0);
  return { time: `${String(hour).padStart(2, "0")}:${m[2]}`, dayOffset: Number(m[4] || 0) };
}
function durationMinutes(text) {
  const m = String(text).match(/^(?:(\d+)h\s*)?(?:(\d+)m)?$/);
  if (!m || (!m[1] && !m[2]) || Number(m[2] || 0) > 59) return null;
  const n = Number(m[1] || 0) * 60 + Number(m[2] || 0);
  return n > 0 ? n : null;
}
function addDays(day, offset) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Validates every displayed row before applying filters or limits. Prices remain per passenger. */
export function normalizeResults(data, search) {
  assertSearchPage(data, search);
  if (
    !Number.isInteger(data.expected_count) ||
    data.rows.length !== data.expected_count ||
    (!data.rows.length && !data.no_results)
  )
    throw new Error(
      "AA did not load the complete displayed result set. No partial prices were returned",
    );
  const results = [];
  const ids = new Set();
  for (const [index, raw] of data.rows.entries()) {
    const fail = (detail) => {
      throw new Error(
        `Cannot read AA flight ${index + 1}: ${detail}. No partial prices were returned`,
      );
    };
    if (!raw.id || ids.has(raw.id)) fail("missing or duplicate flight identity");
    ids.add(raw.id);
    if (raw.origin !== search.from || raw.destination !== search.to)
      fail("route differs from the search");
    const departure = parseClock(raw.departure);
    const arrival = parseClock(raw.arrival);
    const duration = durationMinutes(raw.duration);
    const stopsMatch = raw.stops.match(/^(\d+) stops?\b/);
    const stops = raw.stops === "Nonstop" ? 0 : stopsMatch ? Number(stopsMatch[1]) : null;
    if (
      !departure ||
      departure.dayOffset !== 0 ||
      !arrival ||
      Math.abs(arrival.dayOffset) > 7 ||
      !duration ||
      stops === null
    )
      fail("unrecognized times, duration, or stops");
    if (
      !raw.segments.length ||
      raw.segments.some((s) => !/^\w{2,3} \d+[A-Z]?$/.test(s.flight_number))
    )
      fail("missing flight numbers");
    const fares = raw.fares.filter((f) => !f.unavailable);
    if (!fares.length) fail("no readable available fares");
    const fareNames = new Set();
    for (const fare of fares) {
      if (!fare.name || fareNames.has(fare.name)) fail("missing or duplicate fare name");
      fareNames.add(fare.name);
      const scope = search.returnDate ? "Round trip" : "One way";
      if (fare.scope !== `${scope}${fare.group ? " from" : ""}`) fail("unrecognized price scope");
      if (fare.group && (!fare.description.endsWith(`${scope}, per person.`) || search.miles))
        fail("unverified fare-group price basis");
      const price = search.miles ? null : parseMoney(fare.amount);
      const miles = search.miles ? parseMiles(fare.amount) : null;
      const taxes = search.miles ? parseMoney(fare.addon.replace(/^\+\s*/, "")) : null;
      if (
        search.miles ? miles === null || taxes === null : price === null || price <= 0 || fare.addon
      )
        fail("unrecognized cash/miles amount or taxes");
      results.push({
        rank: 0,
        flight_rank: index + 1,
        result_type: search.returnDate ? "outbound_option" : "one_way_itinerary",
        origin: raw.origin,
        destination: raw.destination,
        departure_date: search.depart,
        departure: departure.time,
        arrival_date: addDays(search.depart, arrival.dayOffset),
        arrival: arrival.time,
        duration_minutes: duration,
        stops,
        stops_text: raw.stops,
        flight_numbers: raw.segments.map((s) => s.flight_number).join(", "),
        segments: raw.segments,
        fare_product: fare.name,
        fare_kind: fare.group ? "fare_group_minimum" : "cabin_offer",
        price,
        miles,
        taxes,
        currency: "USD",
        price_display: [fare.amount, fare.addon].filter(Boolean).join(" "),
        price_basis: search.returnDate
          ? "per_person_round_trip_starting_total_return_not_selected"
          : fare.group
            ? "per_person_one_way_starting"
            : "per_person_one_way",
        price_scope_label: fare.scope,
        passengers: search.adults,
        return_date: search.returnDate,
        pricing: search.miles ? "miles" : "cash",
        loyalty_program: search.miles ? "AAdvantage" : null,
        alerts: raw.alerts,
        displayed_flight_count: data.expected_count,
        search_url: buildSearchUrl(search),
      });
    }
  }
  const stopLimit = { any: Infinity, nonstop: 0, "one-or-fewer": 1, "two-or-fewer": 2 }[
    search.stops
  ];
  const filtered = results.filter(
    (r) =>
      (search.fare === "all" ||
        r.fare_product.toLowerCase().replaceAll(" ", "-") === search.fare) &&
      r.stops <= stopLimit &&
      (search.maxPrice === null || r.price <= search.maxPrice) &&
      (search.maxMiles === null || r.miles <= search.maxMiles) &&
      (search.maxDuration === null || r.duration_minutes <= search.maxDuration),
  );
  if (search.sort !== "best")
    filtered.sort((a, b) => {
      if (search.sort === "price")
        return search.miles ? a.miles - b.miles || a.taxes - b.taxes : a.price - b.price;
      if (search.sort === "duration") return a.duration_minutes - b.duration_minutes;
      return a.departure.localeCompare(b.departure);
    });
  return filtered.slice(0, search.limit).map((r, i) => ({ ...r, rank: i + 1 }));
}
