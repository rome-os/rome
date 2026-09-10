# United flight prices

`united flights` reads United flight search results in money or MileagePlus miles.
It returns one row per flight and displayed fare column. It never selects a fare or books travel.

## Install

```bash
opencli plugin install /path/to/rome/opencli-plugins/united
opencli united flights --help
```

Rome installs this directory through its [OpenCLI plugin install loop](../README.md#install-points-all-idempotent).
The plugin has no runtime dependencies beyond OpenCLI and the browser.

## Search

```bash
# Cash, one-way, nonstop flights sorted by the displayed fare
opencli united flights SFO IAH 2026-11-13 --stops nonstop --sort price -f json

# Award miles with cash taxes and the signed-in account's displayed discounts
opencli united flights SFO IAH 2026-11-13 --miles --max-miles 20000 -f json

# Round-trip search for two adults, returning outbound flight choices
opencli united flights SFO IAH 2026-11-13 --return 2026-11-15 --adults 2 -f json

# Compare all displayed cabin columns, excluding mixed-cabin itineraries
opencli united flights SFO NRT 2026-11-13 --miles --cabin all --exclude-mixed-cabin -f json

# Direct CDP instead of Browser Bridge. Target a tab in the signed-in browser context.
opencli --cdp-endpoint http://127.0.0.1:9222 --cdp-target united.com \
  united flights SFO IAH 2026-11-13 --miles -f json
```

Replace the example dates with future travel dates. Use three-letter airport codes, not city names or URLs.

| Option | Meaning |
| --- | --- |
| `--return YYYY-MM-DD` | Round-trip search. Omit for one-way. |
| `--miles` | Award search. Omit for money. |
| `--adults 1..9` | Adult traveler count. Defaults to 1. |
| `--cabin` | `economy` (default), `economy-plus`, `premium-economy`, `business`, `first`, `business-or-first`, or `all`. |
| `--stops` | `any` (default), `nonstop`, `one-or-fewer`, or `two-or-fewer`. |
| `--max-price` | Maximum displayed USD cash price. Invalid with `--miles`. |
| `--max-miles` | Maximum displayed award miles. Requires `--miles`. |
| `--max-duration` | Maximum outbound duration in minutes. |
| `--exclude-mixed-cabin` | Exclude fares labeled mixed cabin or showing several cabins. |
| `--sort` | `best` (United order), `price`, `duration`, or `departure`. |
| `--limit 1..500` | Fare rows to return. Defaults to 20. |
| `--timeout 5..180` | Seconds to wait for all search results after navigation. Defaults to 90. |

Cabin filters apply to the displayed columns, not to seat assignments. Economy Plus is extra-legroom economy, not Premium Plus or premium economy.
`business` matches business or Polaris columns. Use `business-or-first` to include domestic First.

## Price contract

- `price` is the displayed cash fare in USD. It is null for awards.
- `miles` is the displayed award amount converted to a number. `taxes` is its separate cash amount in USD.
- `price_text` preserves the displayed amount. A rounded `13.5k` label becomes `13500`, not a claim of hidden precision.
- `discount` and `award_type` preserve cardmember discounts and Saver Award labels. The reader uses the current price, never the crossed-out price.
- `price_basis` and `fare_note` describe the pricing scope United displays. Prices remain per person regardless of `--adults`.
- Cash round-trip results show the starting round-trip total per person. Award round-trip results can show one-way miles and taxes per person.
- `--return` returns outbound choices only. No return flight has been selected, so the result is not a final booked itinerary or guaranteed price.
- `is_starting_price` identifies a displayed “From” fare. Prices can change when the traveler chooses a fare or return flight.
- Departure and arrival times are local to their airports. Date labels carry overnight and year-boundary changes.
- Only flights departing on the requested date are returned. United can include departures on the following day in the same result list.

The reader expands **Show all flights** before filtering, sorting, or applying `--limit`.
It retains the highest reported total if the counter disappears during expansion. Visible flight rows must reach that total before results can complete.
Expansion without a reported total fails rather than treating a stable partial list as complete.
For awards, price sorting uses miles first and cash taxes second. It does not convert miles to money.
Calendar suggestions and duplicate desktop/mobile fare elements never become additional flight rows.
`flight_numbers` is empty when the collapsed connecting itinerary does not display its flight numbers. `flight_details` preserves the rendered itinerary text.

## Browser requirements and failures

The command uses a persistent, cookie-backed United site session so award searches reuse the browser tab.
Cash search remains available without signing in. The adapter owns navigation and checks the displayed sign-in wall rather than requiring authentication for every cash request.

Use United in English, United States, USD. The command rejects a different locale or currency rather than guessing how to parse prices.
United requires a MileagePlus sign-in to show award results. Sign in through the browser before using `--miles`.
Prices reflect the account and availability United displays, including eligible cardmember discounts.
The command does not read cookies, credentials, browser storage, authentication headers, or account details.

A sign-in wall raises OpenCLI `AUTH_REQUIRED`. It never falls back from miles to money.
An access challenge, changed search conditions, unreadable fare, or incomplete result load raises an error instead of returning partial prices.
A confirmed no-flight result or an empty filter match returns no rows.

Dates use the origin airport’s local calendar. The command validates their format and order, and United decides whether they are bookable.
It does not compare a departure date against the machine’s UTC date.

Multi-city searches, child/infant travelers, other currencies, fare selection, and booking are outside this command.

## Tests and maintenance

```bash
pnpm -C opencli-plugins/united test
opencli validate united/flights
```

`fixtures/cash.json` and `fixtures/miles.json` contain flight-only DOM reader snapshots captured on 2026-09-10.
They cover cash round-trip totals, current award discounts, mixed cabins, unavailable awards, and overnight flights.
They contain no account identifiers or authentication data. `fixtures/responsive.html` tests hidden flight rows and fare cells in both responsive layouts.
The DOM tests reuse the `jsdom` development dependency declared by `packages/web`. Install the workspace dependencies before running the suite.
CI runs the plugin’s test script after the workspace install.

`united-page.mjs` runs inside the page and must remain self-contained.
United uses separate cash and award layouts. Both expose flight rows and fare cells through ARIA grid roles.
The reader uses those roles and stable class-name fragments, not generated CSS suffixes.
It excludes hidden rows and fare cells without excluding flights below the viewport.
Current prices come from the miles and money containers. Hidden unavailable cards can contain a zero-mile node.
A fare label comes from its column header, with the card's own cabin title as the fallback.

When updating the reader, inspect live money and miles results in the browser, then refresh only the flight data in the fixtures.
Verify one-way and round-trip pricing scope separately. Do not infer an adult count from the `at` URL parameter: it selects award travel.
