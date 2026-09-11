export const FARES = ["all", "basic", "choice", "choice-preferred", "choice-extra"];
export const STOPS = ["any", "nonstop", "one-or-fewer", "two-or-fewer"];
export const SORTS = ["best", "price", "duration", "departure"];

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
      throw new Error(`${name} must be a three-letter airport code, such as OAK`);
    return s;
  };
  const from = airport(args.from, "from");
  const to = airport(args.to, "to");
  if (from === to) throw new Error("from and to must be different airports");
  const depart = date(args.depart, "depart");
  const returnDate = args.return === undefined ? null : date(args.return, "return");
  // Southwest validates origin-local bookability and its current schedule window.
  if (returnDate && returnDate < depart) throw new Error("return must be on or after depart");
  for (const key of ["points", "miles"])
    if (args[key] !== undefined && typeof args[key] !== "boolean")
      throw new Error(`${key} must be a boolean flag`);
  const points = Boolean(args.points || args.miles);
  if (args["max-points"] !== undefined && args["max-miles"] !== undefined)
    throw new Error("Use only one of --max-points and --max-miles");
  const cap = args["max-points"] !== undefined ? args["max-points"] : args["max-miles"];
  const maxPoints = cap === undefined ? null : integer(cap, "max-points", 1, 10000000);
  let maxPrice = null;
  if (args["max-price"] !== undefined) {
    const raw = args["max-price"];
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(String(raw)) ||
      !Number.isFinite(Number(raw)) ||
      Number(raw) <= 0
    )
      throw new Error("max-price must be a positive USD amount");
    maxPrice = Number(raw);
  }
  if (points && maxPrice !== null) throw new Error("Use --max-points for awards, not --max-price");
  if (!points && maxPoints !== null)
    throw new Error("--max-points/--max-miles requires --points or --miles");
  return {
    from,
    to,
    depart,
    returnDate,
    points,
    maxPoints,
    maxPrice,
    adults: integer(args.adults === undefined ? 1 : args.adults, "adults", 1, 8),
    fare: choice(args.fare === undefined ? "all" : args.fare, "fare", FARES),
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
  const url = new URL("https://www.southwest.com/air/booking/select-depart.html");
  const params = {
    adultPassengersCount: String(search.adults),
    adultsCount: String(search.adults),
    departureDate: search.depart,
    departureTimeOfDay: "ALL_DAY",
    destinationAirportCode: search.to,
    fareType: search.points ? "POINTS" : "USD",
    originationAirportCode: search.from,
    passengerType: "ADULT",
    promoCode: "",
    returnTimeOfDay: "ALL_DAY",
    tripType: search.returnDate ? "roundtrip" : "oneway",
  };
  if (search.returnDate) params.returnDate = search.returnDate;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function assertSearchPage(data, search) {
  const url = new URL(data.url);
  const wanted = new URL(buildSearchUrl(search));
  if (url.origin !== wanted.origin || url.pathname !== wanted.pathname)
    throw new Error("Southwest did not open its departing flight results page");
  for (const [k, v] of wanted.searchParams) {
    if ((url.searchParams.get(k) ?? "") !== v || String(data.search?.[k] ?? "") !== v)
      throw new Error(`Southwest did not preserve the requested search field: ${k}`);
  }
  if (
    (!search.returnDate && (url.searchParams.get("returnDate") || data.search?.returnDate)) ||
    Number(data.search?.lapInfantPassengersCount ?? 0) !== 0
  )
    throw new Error("Southwest changed the requested dates or passengers");
  if (data.price_mode !== (search.points ? "points" : "usd"))
    throw new Error("Southwest did not honor cash/points mode. No prices were returned");
  if (!/^en(?:-|$)/i.test(data.language)) throw new Error("Set Southwest to English and retry");
  if (data.route_text !== `${search.from}${search.to}` || data.selected_date !== search.depart)
    throw new Error("Southwest's displayed route or selected date does not match the search");
  if (!search.points && !/Government taxes & fees included/i.test(data.rounding_note))
    throw new Error("Southwest cash taxes and fees inclusion could not be verified");
  if (!/per person for each way of travel/i.test(data.fare_note))
    throw new Error("Southwest's per-person, each-way price scope could not be verified");
}

export function parseAmount(text, points) {
  const number = "(\\d{1,3}(?:,\\d{3})+|\\d+)";
  const re = new RegExp(
    points ? `^${number} Points$` : `^${number}(?:\\.(\\d{1,2}))? Dollars$`,
    "i",
  );
  const m = String(text).match(re);
  if (!m) return null;
  const n = Number(`${m[1].replaceAll(",", "")}.${points ? "0" : m[2] || "0"}`);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function parseTaxes(text) {
  const m = String(text).match(/^\+\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  return m ? Number(`${m[1].replaceAll(",", "")}.${m[2] || "0"}`) : null;
}
function timestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function clockText(text, prefix) {
  const m = String(text).match(new RegExp(`^${prefix} (\\d{1,2}):(\\d{2})(AM|PM)$`));
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return null;
  return `${String((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0)).padStart(2, "0")}:${m[2]}`;
}

/** Emits displayed, available fare rows only. Every price is per person for the outbound direction. */
export function normalizeResults(data, search) {
  assertSearchPage(data, search);
  if (!Number.isInteger(data.expected_count) || data.rows.length !== data.expected_count)
    throw new Error("Southwest did not load every flight. No partial prices were returned");
  if (!data.rows.length) {
    if (!data.no_results) throw new Error("Southwest returned an unrecognized empty results page");
    return [];
  }
  const output = [];
  const ids = new Set();
  for (const row of data.rows) {
    if (!row.id || ids.has(row.id))
      throw new Error("Southwest returned duplicate or unidentified flight rows");
    ids.add(row.id);
    if (
      row.origin !== search.from ||
      row.destination !== search.to ||
      !timestamp(row.departure_at) ||
      !timestamp(row.arrival_at) ||
      row.departure_at.slice(0, 10) !== search.depart
    )
      throw new Error("Southwest flight route or timestamp data is missing or mismatched");
    const elapsed = (Date.parse(row.arrival_at) - Date.parse(row.departure_at)) / 60000;
    const durationMatch = row.duration_text.match(/^(?:(\d+)h\s*)?(\d+)m$/);
    const duration = durationMatch
      ? Number(durationMatch[1] || 0) * 60 + Number(durationMatch[2])
      : null;
    if (
      duration !== row.duration_minutes ||
      duration !== elapsed ||
      duration <= 0 ||
      clockText(row.departure_text, "Departs") !== row.departure_at.slice(11, 16) ||
      clockText(row.arrival_text, "Arrives") !== row.arrival_at.slice(11, 16)
    )
      throw new Error(
        "Southwest's displayed flight times and duration disagree with its flight data",
      );
    const stops =
      row.stops_text === "Nonstop"
        ? 0
        : /^(\d+) stops?$/.test(row.stops_text)
          ? Number(row.stops_text.match(/^\d+/)[0])
          : null;
    const segments = row.segments;
    if (
      stops === null ||
      !Array.isArray(segments) ||
      segments.length !== stops + 1 ||
      segments[0]?.origin !== search.from ||
      segments.at(-1)?.destination !== search.to ||
      segments[0]?.departure_at !== row.departure_at ||
      segments.at(-1)?.arrival_at !== row.arrival_at
    )
      throw new Error("Southwest flight stops or segments could not be verified");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (
        !timestamp(segment.departure_at) ||
        !timestamp(segment.arrival_at) ||
        !/^[A-Z]{3}$/.test(segment.origin) ||
        !/^[A-Z]{3}$/.test(segment.destination) ||
        !/^\d+$/.test(String(segment.flight_number)) ||
        typeof segment.change_planes !== "boolean" ||
        !/^[A-Z0-9]{2}$/.test(segment.marketing_carrier) ||
        !/^[A-Z0-9]{2}$/.test(segment.operating_carrier) ||
        !Number.isInteger(segment.duration_minutes) ||
        segment.duration_minutes <= 0 ||
        (Date.parse(segment.arrival_at) - Date.parse(segment.departure_at)) / 60000 !==
          segment.duration_minutes ||
        !Number.isInteger(segment.stop_minutes) ||
        segment.stop_minutes < 0 ||
        (i &&
          (segments[i - 1].destination !== segment.origin ||
            Date.parse(segment.departure_at) < Date.parse(segments[i - 1].arrival_at)))
      )
        throw new Error("Southwest returned invalid flight segment data");
    }
    if (
      !Array.isArray(row.flight_numbers) ||
      row.flight_numbers.join("/") !==
        [...new Set(segments.map((s) => String(s.flight_number)))].join("/")
    )
      throw new Error("Southwest flight numbers disagree with the itinerary");
    const products = new Set(row.fares.map((f) => f.product));
    if (
      row.fares.length !== 4 ||
      products.size !== 4 ||
      !FARES.slice(1).every((f) => products.has(f))
    )
      throw new Error(
        "Southwest did not render all four fare products. Use a desktop-width browser and retry",
      );
    for (const fare of row.fares) {
      if (fare.unavailable) continue;
      const amount = parseAmount(fare.amount_text, search.points);
      const taxes = search.points ? parseTaxes(fare.taxes_text) : null;
      if (
        fare.points !== search.points ||
        amount === null ||
        (search.points && taxes === null) ||
        (!search.points && fare.taxes_text)
      )
        throw new Error("Southwest returned an unreadable fare or mixed cash/points prices");
      if (search.fare !== "all" && fare.product !== search.fare) continue;
      const stopLimit = { any: Infinity, nonstop: 0, "one-or-fewer": 1, "two-or-fewer": 2 }[
        search.stops
      ];
      if (
        stops > stopLimit ||
        (search.maxDuration !== null && duration > search.maxDuration) ||
        (search.maxPoints !== null && amount > search.maxPoints) ||
        (search.maxPrice !== null && amount > search.maxPrice)
      )
        continue;
      output.push({
        origin: row.origin,
        destination: row.destination,
        departure_date: row.departure_at.slice(0, 10),
        departure: row.departure_at.slice(11, 16),
        arrival_date: row.arrival_at.slice(0, 10),
        arrival: row.arrival_at.slice(11, 16),
        departure_at: row.departure_at,
        arrival_at: row.arrival_at,
        duration_minutes: duration,
        stops,
        flight_numbers: [
          ...new Set(segments.map((s) => `${s.marketing_carrier}${s.flight_number}`)),
        ],
        connection_airports: segments.slice(0, -1).map((s) => s.destination),
        plane_changes: segments.slice(0, -1).filter((s) => s.change_planes).length,
        segments,
        fare_product: fare.product,
        price: search.points ? null : amount,
        points: search.points ? amount : null,
        taxes,
        currency: "USD",
        price_basis: "per_person_each_way",
        cash_price_rounded_up:
          !search.points && /rounded up to the nearest dollar/i.test(data.rounding_note),
        taxes_included: !search.points,
        reward_program: search.points ? "Rapid Rewards" : null,
        adults: search.adults,
        return_date: search.returnDate,
        result_type: search.returnDate ? "outbound_option" : "one_way",
        seats_left: /\d+/.test(fare.seats_text) ? Number(fare.seats_text.match(/\d+/)[0]) : null,
        search_url: buildSearchUrl(search),
      });
    }
  }
  if (search.sort !== "best")
    output.sort((a, b) => {
      if (search.sort === "price")
        return (
          (search.points ? a.points - b.points || a.taxes - b.taxes : a.price - b.price) ||
          a.duration_minutes - b.duration_minutes ||
          a.departure.localeCompare(b.departure)
        );
      if (search.sort === "duration")
        return a.duration_minutes - b.duration_minutes || a.departure.localeCompare(b.departure);
      return a.departure.localeCompare(b.departure) || a.duration_minutes - b.duration_minutes;
    });
  return output.slice(0, search.limit).map((row, index) => ({ rank: index + 1, ...row }));
}
