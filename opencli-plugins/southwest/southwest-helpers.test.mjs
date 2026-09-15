import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSearchPage,
  buildSearchUrl,
  normalizeResults,
  normalizeSearch,
  parseAmount,
  parseTaxes,
} from "./southwest-helpers.mjs";
import { fixture, searchFor } from "./test-fixtures.mjs";

const base = { from: "OAK", to: "HOU", depart: "2026-11-13" };
test("normalizes airport case, cash defaults, and both award aliases", () => {
  const s = normalizeSearch({ ...base, from: " oak ", to: "hou" });
  assert.equal(s.from, "OAK");
  assert.equal(s.to, "HOU");
  assert.equal(s.points, false);
  assert.equal(s.returnDate, null);
  assert.equal(s.adults, 1);
  assert.equal(s.fare, "all");
  assert.deepEqual(
    normalizeSearch({ ...base, miles: true }),
    normalizeSearch({ ...base, points: true }),
  );
  assert.equal(normalizeSearch({ ...base, miles: true, "max-miles": 20000 }).maxPoints, 20000);
});
for (const [field, value] of [
  ["from", "Oakland"],
  ["to", "OAK"],
  ["depart", "11/13/2026"],
  ["depart", "2026-02-30"],
  ["return", "2026-11-12"],
  ["return", ""],
  ["adults", 0],
  ["adults", 9],
  ["adults", 1.5],
  ["adults", null],
  ["adults", true],
  ["points", "true"],
  ["miles", 1],
  ["fare", "business"],
  ["stops", "direct"],
  ["sort", "cheapest"],
  ["limit", 0],
  ["limit", 501],
  ["timeout", 4],
  ["timeout", 181],
  ["max-duration", 0],
  ["max-price", ""],
  ["max-price", "NaN"],
  ["max-price", "20.999"],
  ["max-price", -5],
  ["max-price", true],
])
  test(`rejects invalid ${field}=${JSON.stringify(value)}`, () => {
    assert.throws(() => normalizeSearch({ ...base, [field]: value }));
  });
test("validates price ceilings in the requested currency", () => {
  assert.throws(() => normalizeSearch({ ...base, "max-points": 10000 }), /requires/);
  assert.throws(
    () => normalizeSearch({ ...base, miles: true, "max-price": 100 }),
    /not --max-price/,
  );
  assert.throws(() => normalizeSearch({ ...base, points: true, "max-points": 0 }), /integer/);
  assert.throws(
    () => normalizeSearch({ ...base, points: true, "max-points": 10, "max-miles": 10 }),
    /only one/,
  );
  assert.equal(normalizeSearch({ ...base, "max-price": "200.50" }).maxPrice, 200.5);
});
test("constructs Southwest one-way and round-trip searches without account parameters", () => {
  for (const mode of ["cash", "points"]) {
    const s = searchFor(mode);
    const u = new URL(buildSearchUrl(s));
    assert.equal(u.pathname, "/air/booking/select-depart.html");
    assert.equal(u.searchParams.get("fareType"), mode === "points" ? "POINTS" : "USD");
    assert.equal(u.searchParams.get("adultPassengersCount"), String(s.adults));
    assert.equal(u.searchParams.get("adultsCount"), String(s.adults));
    assert.equal(u.searchParams.get("tripType"), mode === "points" ? "oneway" : "roundtrip");
    assert.equal(u.searchParams.get("returnDate"), s.returnDate);
    assert.equal(u.searchParams.get("promoCode"), "");
  }
});
for (const mode of ["cash", "points"])
  test(`normalizes captured ${mode} prices, true arrival dates, direct stops, and sold-out fares`, () => {
    const rows = normalizeResults(fixture(mode), searchFor(mode));
    assert.equal(rows.length, 15);
    assert.equal(rows[0].price, mode === "cash" ? 200 : null);
    assert.equal(rows[0].points, mode === "points" ? 13500 : null);
    assert.equal(rows[0].taxes, mode === "points" ? 5.6 : null);
    assert.equal(rows[0].price_basis, "per_person_each_way");
    assert.equal(rows[0].result_type, mode === "cash" ? "outbound_option" : "one_way");
    assert.equal(rows[0].cash_price_rounded_up, mode === "cash");
    assert.equal(rows[0].taxes_included, mode === "cash");
    assert.equal(rows[4].stops, 1);
    assert.equal(rows[4].plane_changes, 0);
    assert.deepEqual(rows[4].connection_airports, ["LAS"]);
    assert.equal(rows[8].fare_product, "choice");
    assert.equal(rows.at(-1).arrival_date, "2026-11-14");
    assert.equal(rows.at(-1).plane_changes, 1);
  });
test("filters and sorts before limiting fare rows", () => {
  const s = searchFor("points", {
    fare: "basic",
    stops: "one-or-fewer",
    "max-duration": 400,
    "max-points": 18000,
    sort: "price",
    limit: 2,
  });
  const rows = normalizeResults(fixture(), s);
  assert.deepEqual(
    rows.map((r) => r.points),
    [13500, 17000],
  );
  assert.deepEqual(
    rows.map((r) => r.rank),
    [1, 2],
  );
  assert.equal(normalizeResults(fixture(), searchFor("points", { stops: "nonstop" })).length, 4);
  assert.equal(
    normalizeResults(fixture("cash"), searchFor("cash", { "max-price": "199.99" })).length,
    0,
  );
  assert.equal(normalizeResults(fixture(), searchFor("points", { "max-points": 1 })).length, 0);
  assert.equal(
    normalizeResults(fixture(), searchFor("points", { sort: "departure", limit: 1 }))[0].departure,
    "09:25",
  );
  assert.equal(
    normalizeResults(fixture(), searchFor("points", { sort: "duration", limit: 1 }))[0]
      .duration_minutes,
    215,
  );
});
test("ties in points sort by cash taxes, without combining units", () => {
  const data = fixture();
  data.rows[0].fares[0].taxes_text = "+$12.40";
  data.rows[0].fares[1].amount_text = "13,500 Points";
  const rows = normalizeResults(data, searchFor("points", { sort: "price", limit: 2 }));
  assert.deepEqual(
    rows.map((r) => r.taxes),
    [5.6, 12.4],
  );
});
test("parses exact displayed units, never earned points or crossed currency", () => {
  assert.equal(parseAmount("1,200.50 Dollars", false), 1200.5);
  assert.equal(parseAmount("13,500 Points", true), 13500);
  assert.equal(parseTaxes("+$0.00"), 0);
  assert.equal(parseTaxes("+$42.19"), 42.19);
  for (const text of [
    "13,50 Points",
    "13.5K Points",
    "13,500 Dollars",
    "0 Points",
    "-500 Points",
    "500 Points + $5.60",
  ])
    assert.equal(parseAmount(text, true), null);
  assert.equal(parseAmount("200 Points", false), null);
  assert.equal(parseTaxes(""), null);
});
for (const [field, value] of [
  ["originationAirportCode", "SFO"],
  ["destinationAirportCode", "IAH"],
  ["departureDate", "2026-11-14"],
  ["adultPassengersCount", "1"],
  ["adultsCount", "1"],
  ["fareType", "USD"],
  ["tripType", "roundtrip"],
  ["departureTimeOfDay", "MORNING"],
  ["promoCode", "SALE"],
  ["lapInfantPassengersCount", "1"],
  ["returnDate", "2026-11-20"],
])
  test(`rejects stale or changed search state: ${field}`, () => {
    const d = fixture();
    d.search[field] = value;
    assert.throws(() => assertSearchPage(d, searchFor()));
  });
for (const [field, value] of [
  ["price_mode", "usd"],
  ["price_mode", "usd_plus_points"],
  ["selected_date", "2026-11-14"],
  ["route_text", "HOUOAK"],
  ["language", "es"],
  ["fare_note", "round trip total"],
  ["url", "https://www.southwest.com/air/booking/select-return.html"],
])
  test(`rejects wrong displayed ${field}`, () => {
    const d = fixture();
    d[field] = value;
    assert.throws(() => assertSearchPage(d, searchFor()));
  });
test("only a confirmed, complete empty search returns no flights", () => {
  const d = { ...fixture(), rows: [], expected_count: 0, no_results: true };
  assert.deepEqual(normalizeResults(d, searchFor()), []);
  assert.throws(
    () => normalizeResults({ ...d, no_results: false }, searchFor()),
    /unrecognized empty/,
  );
  assert.throws(
    () => normalizeResults({ ...fixture(), expected_count: 5 }, searchFor()),
    /every flight/,
  );
});
for (const [label, mutate] of [
  [
    "missing React props",
    (r) => {
      r.departure_at = null;
    },
  ],
  [
    "wrong origin",
    (r) => {
      r.origin = "SFO";
    },
  ],
  [
    "wrong departure date",
    (r) => {
      r.departure_at = "2026-11-14T11:55:00.000-08:00";
    },
  ],
  [
    "duration disagreement",
    (r) => {
      r.duration_minutes = 216;
    },
  ],
  [
    "displayed time disagreement",
    (r) => {
      r.departure_text = "Departs 11:54AM";
    },
  ],
  [
    "missing stops",
    (r) => {
      r.stops_text = "";
    },
  ],
  [
    "missing segments",
    (r) => {
      r.segments = [];
    },
  ],
  [
    "missing flight numbers",
    (r) => {
      r.flight_numbers = [];
    },
  ],
  [
    "missing fare column",
    (r) => {
      r.fares.pop();
    },
  ],
  [
    "unknown fare product",
    (r) => {
      r.fares[0].product = "business";
    },
  ],
  [
    "wrong currency",
    (r) => {
      r.fares[0].points = false;
    },
  ],
  [
    "unreadable award",
    (r) => {
      r.fares[0].amount_text = "unknown";
    },
  ],
  [
    "missing taxes",
    (r) => {
      r.fares[0].taxes_text = "";
    },
  ],
])
  test(`rejects ${label}, even on a filtered-out row`, () => {
    const d = fixture();
    mutate(d.rows[1]);
    assert.throws(() => normalizeResults(d, searchFor("points", { stops: "nonstop", limit: 1 })));
  });
test("does not silently deduplicate inconsistent rows", () => {
  const d = fixture();
  d.rows[1].id = d.rows[0].id;
  assert.throws(() => normalizeResults(d, searchFor()), /duplicate/);
});

test("cash tax inclusion must be verified", () => {
  const d = fixture("cash");
  d.rounding_note = "Taxes calculated later";
  assert.throws(() => normalizeResults(d, searchFor("cash")), /taxes and fees inclusion/);
});
test("null ceilings and defaults are not silently ignored", () => {
  for (const key of [
    "adults",
    "fare",
    "stops",
    "sort",
    "limit",
    "timeout",
    "max-points",
    "max-miles",
  ])
    assert.throws(() => normalizeSearch({ ...base, points: true, [key]: null }));
});
test("preserves the marketing carrier rather than assuming a flight prefix", () => {
  const d = fixture();
  d.rows[0].segments[0].marketing_carrier = "XY";
  assert.deepEqual(normalizeResults(d, searchFor())[0].flight_numbers, ["XY1166"]);
});
