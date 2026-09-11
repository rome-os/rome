import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  arrivalDate,
  assertSearchPage,
  buildSearchUrl,
  cabinOf,
  normalizeResults,
  normalizeSearch,
  parseMiles,
  parseMoney,
  timeMinutes,
} from "./delta-helpers.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/miles.json", import.meta.url)));
const args = { from: "SFO", to: "JFK", depart: "2026-11-13", adults: 2, miles: true };
const search = (patch = {}) => normalizeSearch({ ...args, ...patch });

test("normalizes route and builds separate cash and award deep links", () => {
  for (const miles of [false, true]) {
    const s = search({ from: " sfo ", to: "jfk", miles, return: "2026-11-20" });
    const url = new URL(buildSearchUrl(s));
    assert.equal(url.origin, "https://www.delta.com");
    assert.equal(url.searchParams.get("awardTravel"), String(miles));
    assert.equal(url.searchParams.get("paxCount"), "2");
    assert.equal(url.searchParams.get("returnDate"), "2026-11-20");
    assert.equal(url.searchParams.get("tripType"), "ROUND_TRIP");
    assert.equal(url.searchParams.get("originCity"), "SFO");
  }
  const url = new URL(buildSearchUrl(search()));
  assert.equal(url.searchParams.get("tripType"), "ONE_WAY");
  assert.equal(url.searchParams.has("returnDate"), false);
});

for (const [name, patch] of Object.entries({
  airport: { from: "San Francisco" },
  same: { to: "SFO" },
  date: { depart: "2026-02-30" },
  format: { depart: "11/13/2026" },
  return: { return: "2026-11-12" },
  adults: { adults: 0 },
  fraction: { adults: 1.1 },
  limit: { limit: 0 },
  timeout: { timeout: 181 },
  cabin: { cabin: "spaceship" },
  stops: { stops: "three" },
  sort: { sort: "cheap" },
  bool: { miles: "false" },
  mixed: { "exclude-mixed-cabin": "true" },
  cashMiles: { miles: true, "max-price": "100" },
  milesCash: { miles: false, "max-miles": 1000 },
  zero: { "max-miles": 0 },
  infinity: { miles: false, "max-price": "Infinity" },
  negative: { "max-duration": -1 },
  invalidDate: { depart: "2026-13-01" },
}))
  test(`rejects invalid argument: ${name}`, () => assert.throws(() => search(patch)));

test("calendar validation leaves origin-local bookability to Delta", () => {
  assert.equal(search({ depart: "2024-02-29", return: "2024-02-29" }).depart, "2024-02-29");
});

test("parses displayed USD and integer miles without manufacturing cents or a discount", () => {
  assert.equal(parseMoney("$ 1,234.56"), 1234.56);
  assert.equal(parseMoney("+$6"), 6);
  assert.equal(parseMoney("$0"), 0);
  for (const value of ["€12", "C$12", "$12,34", "$5.600", "NaN"])
    assert.equal(parseMoney(value), null);
  assert.equal(parseMiles("Actual Fare 33,300 miles"), 33300);
  assert.equal(parseMiles("28,300"), 28300);
  for (const value of ["0", "-1", "33.3k", "33,300 28,300", "Infinity"])
    assert.equal(parseMiles(value), null);
});

test("preserves award taxes, promotional offer, overnight dates and actual cabin rather than column", () => {
  const rows = normalizeResults(fixture(), search({ cabin: "all" }), "2026-09-11T00:00:00Z");
  const row = rows[0];
  assert.equal(row.miles, 33300);
  assert.equal(row.taxes, 6);
  assert.equal(row.price, null);
  assert.equal(row.card_member_miles, 28300);
  assert.equal(row.card_member_taxes, 6);
  assert.equal(row.card_member_offer, "Card Members");
  assert.equal(row.price_basis, "one_way_per_passenger");
  assert.equal(row.adults, 2);
  assert.equal(row.stops, 0);
  assert.equal(row.retrieved_at, "2026-09-11T00:00:00Z");
  assert.ok(rows.some((r) => r.arrival_date === "2026-11-14"));
  assert.ok(rows.some((r) => r.fare_column === "Premium Select" && r.cabin === "first"));
  assert.ok(rows.every((r) => r.miles > 0));
});

test("cash and round-trip fares retain per-passenger starting total, never a fabricated return leg", () => {
  const data = fixture();
  const s = search({ miles: false, return: "2026-11-20" });
  data.search.award = "false";
  data.search.trip_type = "ROUND_TRIP";
  data.search.segments[0].return_date = s.returnDate;
  data.price_mode = "$USD";
  data.leg = "Outbound";
  data.fare_note = "Fares are round-trip per passenger, including taxes and fees.";
  for (const row of data.rows)
    for (const fare of row.fares) {
      if (!fare.products.length) continue;
      Object.assign(fare, {
        cash_text: "$ 499.50",
        miles_text: "",
        taxes_text: "",
        promo_text: "",
        promo_label: "",
        trip_type: "Round Trip",
        text: "From $499.50 Round Trip",
      });
    }
  const row = normalizeResults(data, s)[0];
  assert.equal(row.price, 499.5);
  assert.equal(row.miles, null);
  assert.equal(row.taxes, null);
  assert.equal(row.price_basis, "round_trip_per_passenger_starting_total");
  assert.equal(row.leg, "outbound");
  assert.equal(row.is_starting_price, true);
  assert.equal(row.return_date, "2026-11-20");
});

test("filters and sorts all fare rows before applying limit, using standard miles", () => {
  const data = fixture();
  const rows = normalizeResults(data, search({ "max-miles": 30000, sort: "price", limit: 1 }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].miles, 21900);
  assert.equal(rows[0].flight_index, 3);
  assert.equal(normalizeResults(data, search({ stops: "nonstop", "max-miles": 30000 })).length, 0);
  assert.ok(
    normalizeResults(data, search({ "max-duration": 400 })).every((r) => r.duration_minutes <= 400),
  );
  const sorted = normalizeResults(data, search({ sort: "departure" }));
  assert.equal(sorted[0].departure, "7:00 am");
});

test("mixed cabins do not enter economy and can be excluded", () => {
  const data = fixture();
  data.rows[0].fares[0].products = ["Delta Main", "Delta Comfort Classic"];
  assert.equal(
    normalizeResults(data, search()).some((r) => r.flight_index === 1),
    false,
  );
  assert.equal(normalizeResults(data, search({ cabin: "comfort" }))[0].mixed_cabin, true);
  assert.ok(
    normalizeResults(data, search({ cabin: "all", "exclude-mixed-cabin": true })).every(
      (r) => !r.mixed_cabin,
    ),
  );
});

for (const [name, mutate] of Object.entries({
  mode: (d) => (d.price_mode = "$USD"),
  award: (d) => (d.search.award = "false"),
  missingSearch: (d) => (d.search = null),
  origin: (d) => (d.search.segments[0].origin = "LAX"),
  date: (d) => (d.search.segments[0].departure_date = "2026-11-14"),
  return: (d) => (d.search.segments[0].return_date = "2026-11-20"),
  count: (d) => (d.search.passengers[0].count = "1"),
  flexible: (d) => (d.search.flexible = true),
  refund: (d) => (d.search.refundable = true),
  basic: (d) => (d.search.exclude_basic = true),
  displayedDate: (d) => (d.date_heading = "Sat, Nov 14, 2026"),
  route: (d) => (d.route_text = "SFO IAH"),
  leg: (d) => (d.leg = "Inbound"),
  locale: (d) => (d.locale = "Canada - English"),
  language: (d) => (d.language = "zh"),
  mobile: (d) => (d.desktop = false),
  scope: (d) => (d.fare_note = "Total for all passengers"),
  url: (d) => (d.url = "https://evil.test/flightsearch/search-results"),
}))
  test(`rejects mismatched loaded search: ${name}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(() => assertSearchPage(data, search()));
  });

for (const [name, mutate] of Object.entries({
  route: (f) => (f.route_label = "Flight from LAX to JFK"),
  duration: (f) => (f.duration_text = "fast"),
  stops: (f) => {
    f.nonstop = false;
    f.stop_labels = [];
  },
  time: (f) => (f.departure = "25:00 pm"),
  flight: (f) => (f.flight_numbers = [""]),
  price: (f) => (f.fares[0].miles_text = "Actual Fare 33.3k miles"),
  mixedMoney: (f) => (f.fares[0].cash_text = "$333"),
  tax: (f) => (f.fares[0].taxes_text = ""),
  cabin: (f) => (f.fares[0].products = ["Mystery"]),
  trip: (f) => (f.fares[0].trip_type = "Round Trip"),
  promo: (f) => (f.fares[0].promo_text = "bad"),
}))
  test(`fails closed on malformed flight: ${name}`, () => {
    const data = fixture();
    mutate(data.rows[0]);
    assert.throws(() => normalizeResults(data, search()));
  });

test("handles year boundaries and rejects malformed arrival dates", () => {
  assert.equal(arrivalDate("Fri, Jan 1", "2026-12-31"), "2027-01-01");
  assert.equal(arrivalDate("Thu, Dec 31", "2027-01-01"), "2026-12-31");
  assert.throws(() => arrivalDate("Feb 30", "2026-02-28"));
  assert.throws(() => arrivalDate("Fri, Feb 30", "2026-02-28"));
  assert.equal(timeMinutes("12:00 am"), 0);
  assert.equal(timeMinutes("12:00 pm"), 720);
  assert.equal(cabinOf("Delta Comfort"), "comfort");
  assert.equal(cabinOf("Delta Premium Select"), "premium-economy");
});
