import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertSearchPage,
  buildSearchUrl,
  cabinOf,
  dateFromNote,
  normalizeResults,
  normalizeSearch,
  parseMiles,
  parseMoney,
  priceBasis,
  timeMinutes,
} from "./united-helpers.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const args = { from: "SFO", to: "IAH", depart: "2026-11-13", return: "2026-11-15" };
const search = (extra = {}) => normalizeSearch({ ...args, ...extra });
const results = (mode, extra = {}, data = fixture(mode)) =>
  normalizeResults(
    data,
    search({ adults: mode === "cash" ? 2 : 1, miles: mode === "miles", ...extra }),
    "2026-09-10T00:00:00.000Z",
  );

test("normalizes airports and defaults", () => {
  const s = search({ from: " sfo ", to: "iah", return: undefined });
  assert.equal(s.from, "SFO");
  assert.equal(s.to, "IAH");
  assert.equal(s.cabin, "economy");
  assert.equal(s.returnDate, null);
});

test("award flag is at, adult count is px", () => {
  for (const miles of [false, true])
    for (const adults of [1, 2, 9]) {
      const p = new URL(buildSearchUrl(search({ miles, adults }))).searchParams;
      assert.equal(p.get("at"), miles ? "1" : null);
      assert.equal(p.get("tqp"), miles ? "A" : "R");
      assert.equal(p.get("px"), String(adults));
      assert.equal(p.get("r"), "2026-11-15");
      assert.equal(p.get("sc"), "7,7");
      assert.equal(p.get("tt"), null);
    }
  const oneWay = new URL(buildSearchUrl(search({ return: undefined }))).searchParams;
  assert.equal(oneWay.get("tt"), "1");
  assert.equal(oneWay.get("r"), null);
  assert.equal(oneWay.get("sc"), "7");
});

for (const invalid of [
  { from: "San Francisco" },
  { to: "SFO" },
  { from: "SFO&t=LAX" },
  { depart: "2026-02-30" },
  { depart: "2026-9-12" },
  { return: "2026-11-12" },
  { return: "" },
  { adults: 0 },
  { adults: 10 },
  { adults: 1.5 },
  { cabin: "suite" },
  { sort: "cheap" },
  { stops: "3" },
  { limit: 0 },
  { limit: 501 },
  { timeout: 4 },
  { miles: "false" },
  { "max-miles": 10000 },
  { miles: true, "max-price": 200 },
  { "max-price": "NaN" },
  { "max-price": -1 },
  { miles: true, "max-miles": 2.5 },
  { "max-duration": 0 },
]) {
  test(`rejects invalid search ${JSON.stringify(invalid)}`, () =>
    assert.throws(() => search(invalid)));
}

test("accepts leap days and a same-day return", () => {
  assert.equal(
    normalizeSearch({ from: "SFO", to: "LAX", depart: "2028-02-29", return: "2028-02-29" })
      .returnDate,
    "2028-02-29",
  );
});

test("parses USD without treating unknown or unavailable as zero", () => {
  assert.equal(parseMoney("$1,784"), 1784);
  assert.equal(parseMoney("$5.60"), 5.6);
  assert.equal(parseMoney("US $0.00"), 0);
  for (const value of ["", "Not available", "€200", "CA$200", "$1,23", "$1.2", "Was $500 Now $200"])
    assert.equal(parseMoney(value), null);
});

test("parses compact miles without floating point integer errors", () => {
  for (const [value, expected] of [
    ["13.5k", 13500],
    ["65.4k", 65400],
    ["15,000 miles", 15000],
    ["1.25M", 1250000],
    ["0", 0],
  ])
    assert.equal(parseMiles(value), expected);
  for (const value of ["", "$15", "Not available", "1.5 miles", "15kk", "13,5k"])
    assert.equal(parseMiles(value), null);
});

test("cash roundtrip is a starting total per person, not multiplied by adults", () => {
  const rows = results("cash");
  assert.ok(rows.length);
  assert.equal(rows[0].price, 454);
  assert.equal(rows[0].adults, 2);
  assert.equal(rows[0].price_basis, "round_trip_per_person_starting_total");
  assert.equal(rows[0].leg, "outbound");
  assert.equal(rows[0].miles, null);
  assert.equal(rows[0].taxes, null);
});

test("award result uses current discounted miles plus taxes, not the crossed-out price", () => {
  const row = results("miles")[0];
  assert.equal(row.miles, 13500);
  assert.equal(row.taxes, 5.6);
  assert.equal(row.price, null);
  assert.equal(row.discount, "cardmembers save 10%");
  assert.equal(row.award_type, "Saver Award");
  assert.equal(row.price_basis, "one_way_per_person");
  assert.equal(row.price_text, "13.5k miles + $5.60");
  assert.equal(row.arrival_date, "2026-11-14");
});

test("skips unavailable awards even when the hidden miles node is zero", () => {
  const rows = results("miles", { cabin: "all" });
  assert.ok(rows.length);
  assert.ok(rows.every((row) => row.miles > 0));
});

test("keeps Economy Plus separate from Premium Plus and Economy", () => {
  assert.equal(cabinOf("Economy Plus®(Extra legroom)"), "economy-plus");
  assert.equal(cabinOf("United Premium Plus®"), "premium-economy");
  assert.equal(cabinOf("Premium economy"), "premium-economy");
  assert.equal(cabinOf("United Polaris® business"), "business");
  assert.equal(cabinOf("First(lowest)"), "first");
  assert.ok(results("cash", { cabin: "economy-plus" }).every((row) => row.price >= 700));
  assert.equal(results("cash", { cabin: "premium-economy" }).length, 0);
});

test("mixed cabins remain explicit and can be excluded", () => {
  const all = results("miles", { cabin: "first" });
  assert.ok(all.some((row) => row.mixed_cabin));
  assert.ok(
    results("miles", { cabin: "first", "exclude-mixed-cabin": true }).every(
      (row) => !row.mixed_cabin,
    ),
  );
});

test("filters then sorts then limits fare rows", () => {
  const rows = results("miles", { sort: "price", stops: "nonstop", "max-miles": 14000, limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].miles, 13500);
  assert.equal(rows[0].stops, 0);
  assert.equal(results("cash", { "max-price": 1 }).length, 0);
  assert.equal(results("miles", { "max-duration": 1 }).length, 0);
});

test("never counts next-day departures as the requested day", () => {
  const data = fixture("cash");
  const nextDay = structuredClone(data.rows[0]);
  nextDay.departure_note = "Departs Nov 14";
  nextDay.fares[0].money_text = "$1";
  data.rows.unshift(nextDay);
  assert.ok(results("cash", { sort: "price" }, data).every((row) => row.price !== 1));
});

test("handles midnight and year-boundary arrival labels", () => {
  assert.equal(timeMinutes("12:45 AM"), 45);
  assert.equal(timeMinutes("12:00 PM"), 720);
  assert.equal(timeMinutes("11:59 PM"), 1439);
  assert.equal(timeMinutes("13:00 PM"), null);
  assert.equal(dateFromNote("Arrives Jan 1", "2026-12-31"), "2027-01-01");
  assert.equal(dateFromNote("Arrives Dec 31", "2027-01-01"), "2026-12-31");
  assert.throws(() => dateFromNote("Arrives Feb 30", "2027-02-28"));
  assert.throws(() => dateFromNote("unknown", "2026-11-13"));
});

test("keeps unrecognized fare bases explicit", () => {
  assert.equal(priceBasis("one-way, per person"), "one_way_per_person");
  assert.equal(
    priceBasis("All fares shown are the total price roundtrip, per person."),
    "round_trip_per_person_starting_total",
  );
  assert.equal(priceBasis(""), "displayed_price_see_fare_note");
});

for (const [name, mutate] of [
  [
    "wrong mode",
    (d) => {
      d.price_mode = "money";
    },
  ],
  [
    "wrong airport",
    (d) => {
      d.url = d.url.replace("t=IAH", "t=LAX");
    },
  ],
  [
    "wrong date",
    (d) => {
      d.date_heading = "Depart on: November 14";
    },
  ],
  [
    "return leg",
    (d) => {
      d.url += "&idx=2";
    },
  ],
  [
    "wrong adults",
    (d) => {
      d.traveler_text = "2 Adults";
    },
  ],
  [
    "different currency",
    (d) => {
      d.currency = "CAD";
    },
  ],
  [
    "different language",
    (d) => {
      d.language = "de";
    },
  ],
  [
    "wrong site",
    (d) => {
      d.url = d.url.replace("www.united.com", "example.com");
    },
  ],
])
  test(`rejects stale or changed search: ${name}`, () => {
    const data = fixture("miles");
    mutate(data);
    assert.throws(() => assertSearchPage(data, search({ miles: true })));
  });

test("missing or mismatched prices fail rather than return partial rows", () => {
  const data = fixture("miles");
  data.rows[1].fares[0].money_text = "";
  assert.throws(() => results("miles", {}, data), /No partial/);
  data.rows[1].fares[0].money_text = "$5.60";
  data.rows[1].fares[0].miles_text = "unknown";
  assert.throws(() => results("miles", {}, data), /No partial/);
});

test("cash does not accept a miles-shaped card", () => {
  const data = fixture("cash");
  data.rows[0].fares[0].miles_text = "15k";
  assert.throws(() => results("cash", {}, data), /mode changed/);
});

test("rejects bare numeric options and non-boolean flags", () => {
  for (const invalid of [
    { adults: true },
    { adults: "" },
    { "max-price": true },
    { "exclude-mixed-cabin": "false" },
  ])
    assert.throws(() => search(invalid));
});

test("leaves origin-local date availability to United across UTC midnight", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T02:00:00Z") });
  assert.equal(new Date().toISOString().slice(0, 10), "2026-11-14");
  const requested = normalizeSearch({ from: "SFO", to: "IAH", depart: "2026-11-13" });
  assert.equal(requested.depart, "2026-11-13");
  assert.equal(new URL(buildSearchUrl(requested)).searchParams.get("d"), "2026-11-13");
});

test("leaves even an old valid date to United instead of guessing an airport timezone", () => {
  assert.equal(search({ depart: "2024-02-29" }).depart, "2024-02-29");
});
