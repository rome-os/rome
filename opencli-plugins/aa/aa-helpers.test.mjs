import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSearchPage,
  buildSearchUrl,
  normalizeResults,
  normalizeSearch,
  parseClock,
  parseMiles,
  parseMoney,
} from "./aa-helpers.mjs";
import { argsFor, fixture, searchFor } from "./test-fixtures.mjs";

test("normalizes airport codes and safe defaults", () => {
  const s = normalizeSearch(argsFor("cash", { from: " sfo ", to: "dfw" }));
  assert.equal(s.from, "SFO");
  assert.equal(s.to, "DFW");
  assert.equal(s.adults, 1);
  assert.equal(s.miles, false);
  assert.equal(s.returnDate, null);
});
for (const [key, value] of [
  ["from", "San Francisco"],
  ["to", "SFO"],
  ["from", "SFO,OAK"],
  ["depart", "2026-02-30"],
  ["depart", "11/13/2026"],
  ["return", "2026-11-12"],
  ["return", ""],
  ["adults", 0],
  ["adults", 10],
  ["adults", 1.2],
  ["adults", null],
  ["miles", "true"],
  ["max-price", "NaN"],
  ["max-price", "12.345"],
  ["max-price", 0],
  ["max-miles", 1000],
  ["limit", 0],
  ["limit", 501],
  ["timeout", 4],
  ["timeout", 181],
  ["max-duration", -1],
  ["stops", "three"],
  ["sort", "cheapest"],
  ["fare", "first"],
])
  test(`rejects invalid ${key}=${value}`, () =>
    assert.throws(() => normalizeSearch(argsFor("cash", { [key]: value }))));
for (const args of [
  { miles: true, "max-price": 500 },
  { miles: true, "max-miles": 0 },
  { miles: true, fare: "premium" },
  { miles: true, fare: "main-extra" },
])
  test(`rejects conflicting award options ${JSON.stringify(args)}`, () =>
    assert.throws(() => normalizeSearch(argsFor("cash", args))));
test("accepts leap days, same-day returns, and nine passengers", () => {
  const s = normalizeSearch(
    argsFor("cash", { depart: "2028-02-29", return: "2028-02-29", adults: 9 }),
  );
  assert.equal(s.adults, 9);
});
for (const mode of ["cash", "award", "round-cash", "round-award"])
  test(`constructs public ${mode} search link`, () => {
    const s = searchFor(mode);
    const u = new URL(buildSearchUrl(s));
    const p = u.searchParams;
    const slices = JSON.parse(p.get("slices"));
    assert.equal(u.origin, "https://www.aa.com");
    assert.equal(p.get("searchType"), s.miles ? "Award" : "Revenue");
    assert.equal(p.get("adult"), String(s.adults));
    assert.equal(p.get("pax"), String(s.adults));
    assert.equal(slices.length, s.returnDate ? 2 : 1);
    assert.equal(slices[0].orig, s.from);
    assert.equal(slices[0].dest, s.to);
    assert.equal(slices[0].date, s.depart);
    assert.equal(slices[0].origNearby, false);
    assert.equal(p.get("carriers"), "ALL");
    assert.equal(p.get("locale"), "en_US");
    if (s.returnDate) {
      assert.equal(slices[1].orig, s.to);
      assert.equal(slices[1].date, s.returnDate);
    }
  });
for (const [input, expected] of [
  ["27K", 27000],
  ["32.5K", 32500],
  ["1.25M", 1250000],
  ["10,000", 10000],
  ["0.001K", 1],
  ["NaN", null],
  ["$206", null],
  ["12,34K", null],
  ["0", null],
  ["1.5", null],
  ["27K + $5.60", null],
])
  test(`parses miles ${input}`, () => assert.equal(parseMiles(input), expected));
for (const [input, expected] of [
  ["$1,000.53", 1000.53],
  ["$206", 206],
  ["$0.00", 0],
  ["$5.6", 5.6],
  ["CA$206", null],
  ["€206", null],
  ["$12,34", null],
  ["$5.60 +", null],
])
  test(`parses money ${input}`, () => assert.equal(parseMoney(input), expected));
test("parses midnight, noon, overnight and prior-day arrivals", () => {
  assert.deepEqual(parseClock("12:00 AM"), { time: "00:00", dayOffset: 0 });
  assert.deepEqual(parseClock("12:00 PM"), { time: "12:00", dayOffset: 0 });
  assert.deepEqual(parseClock("5:50 AM+1 , Arrives on November 14"), {
    time: "05:50",
    dayOffset: 1,
  });
  assert.deepEqual(parseClock("8:00 AM -1"), { time: "08:00", dayOffset: -1 });
  for (const s of ["13:00 PM", "12:60 AM", "5:30", "06:55 PM unknown"])
    assert.equal(parseClock(s), null);
});
for (const field of [
  "from",
  "to",
  "depart",
  "return_date",
  "miles",
  "trip_type",
  "header_from",
  "header_to",
  "header_passengers",
  "direction",
  "date_label",
])
  test(`rejects changed search field ${field}`, () => {
    const d = fixture();
    d.search[field] = "wrong";
    assert.throws(() => assertSearchPage(d, searchFor()), /preserve/);
  });
for (const passengers of [
  null,
  [],
  [{ type: "child", count: 1 }],
  [{ type: "adult", count: 2 }],
  [
    { type: "adult", count: 1 },
    { type: "infant", count: 1 },
  ],
])
  test(`rejects altered travelers ${JSON.stringify(passengers)}`, () => {
    const d = fixture();
    d.search.passengers = passengers;
    assert.throws(() => assertSearchPage(d, searchFor()), /passengers/);
  });
for (const field of ["origin", "path", "language", "width"])
  test(`rejects unsupported ${field}`, () => {
    const d = fixture();
    d[field] = field === "width" ? 800 : "other";
    assert.throws(() => assertSearchPage(d, searchFor()));
  });
test("cash is a fare-group minimum, not an exact cabin or a party total", () => {
  const rows = normalizeResults(fixture(), searchFor());
  assert.equal(rows.length, 15);
  assert.equal(rows[0].price, 206);
  assert.equal(rows[0].miles, null);
  assert.equal(rows[0].taxes, null);
  assert.equal(rows[0].fare_kind, "fare_group_minimum");
  assert.equal(rows[0].price_basis, "per_person_one_way_starting");
  assert.equal(rows[6].arrival_date, "2026-11-14");
});
test("awards separate miles and cash taxes and omit unavailable products", () => {
  const rows = normalizeResults(fixture("award"), searchFor("award"));
  assert.equal(rows.length, 9);
  assert.equal(rows[0].miles, 27000);
  assert.equal(rows[0].taxes, 5.6);
  assert.equal(rows[0].price, null);
  assert.equal(rows[6].taxes, 11.2);
  assert.equal(rows.at(-1).flight_numbers, "AS 1450, AA 2438");
});
for (const mode of ["round-cash", "round-award"])
  test(`${mode} labels a starting round-trip per-person total, with no return selected`, () => {
    const rows = normalizeResults(fixture(mode), searchFor(mode));
    assert.equal(rows[0].passengers, 2);
    assert.equal(rows[0].result_type, "outbound_option");
    assert.equal(rows[0].price_basis, "per_person_round_trip_starting_total_return_not_selected");
    assert.equal(rows[0].price, mode === "round-cash" ? 697 : null);
    assert.equal(rows[0].miles, mode === "round-award" ? 45000 : null);
    assert.equal(rows[0].taxes, mode === "round-award" ? 549.03 : null);
  });
test("filters and sorts before limiting", () => {
  const rows = normalizeResults(
    fixture("award"),
    searchFor("award", {
      fare: "main",
      stops: "nonstop",
      sort: "price",
      "max-miles": 30000,
      "max-duration": 220,
      limit: 1,
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].miles, 23500);
  assert.equal(rows[0].rank, 1);
  const cash = normalizeResults(
    fixture(),
    searchFor("cash", { fare: "main", sort: "price", "max-price": "210", limit: 2 }),
  );
  assert.equal(cash.length, 2);
  assert.equal(cash[1].price, 206);
});
test("price ties on awards sort by taxes and otherwise preserve AA order", () => {
  const d = fixture("award");
  d.rows[0].fares[0].amount = "10K";
  d.rows[0].fares[0].addon = "+ $20.00";
  const rows = normalizeResults(d, searchFor("award", { sort: "price", fare: "main" }));
  assert.equal(rows[0].taxes, 11.2);
});
for (const sort of ["departure", "duration"])
  test(`sorts ${sort}`, () => {
    const rows = normalizeResults(fixture(), searchFor("cash", { sort }));
    const key = sort === "departure" ? "departure" : "duration_minutes";
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i][key] >= rows[i - 1][key]);
  });
test("empty filters return empty rows", () =>
  assert.deepEqual(normalizeResults(fixture(), searchFor("cash", { "max-price": "1" })), []));
test("explicit verified empty result returns no fares", () => {
  const d = fixture();
  d.rows = [];
  d.expected_count = 0;
  d.no_results = true;
  assert.deepEqual(normalizeResults(d, searchFor()), []);
});
for (const mutate of [
  (d) => d.rows.pop(),
  (d) => (d.expected_count = null),
  (d) => (d.rows[4].origin = "OAK"),
  (d) => (d.rows[4].departure = "invalid"),
  (d) => (d.rows[4].arrival = "bad"),
  (d) => (d.rows[4].stops = "unknown"),
  (d) => (d.rows[4].duration = "0h 0m"),
  (d) => (d.rows[4].segments = []),
  (d) => (d.rows[4].id = d.rows[0].id),
  (d) => (d.rows[4].fares[0].amount = "27K"),
  (d) => (d.rows[4].fares[0].scope = "Round trip from"),
  (d) => (d.rows[4].fares[0].description = "unknown"),
  (d) => (d.rows[4].fares = []),
])
  test(`fails closed before limits: ${mutate}`, () => {
    const d = fixture();
    mutate(d);
    assert.throws(
      () => normalizeResults(d, searchFor("cash", { limit: 1 })),
      /No partial|partial prices|complete/,
    );
  });
test("missing award taxes or cash fallback fail closed", () => {
  for (const patch of [{ addon: "" }, { amount: "$206" }, { amount: "0K" }]) {
    const d = fixture("award");
    Object.assign(d.rows[0].fares[0], patch);
    assert.throws(() => normalizeResults(d, searchFor("award")), /No partial/);
  }
});

test("rejects null filters instead of silently using defaults", () => {
  for (const key of ["fare", "stops", "sort"])
    assert.throws(() => normalizeSearch(argsFor("cash", { [key]: null })));
});
test("non-finite monetary input is not a fare", () => {
  assert.equal(parseMoney(`$${"9".repeat(400)}`), null);
});
