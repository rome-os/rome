# American Airlines flights

```bash
opencli aa flights FROM TO YYYY-MM-DD [--return YYYY-MM-DD] [--miles]
```

Search aa.com for cash fares or AAdvantage awards. Use three-letter airport codes and travel dates.
The command reads displayed results and does not select flights, reserve tickets, or spend money or miles.

```bash
opencli aa flights SFO DFW 2026-11-13 --sort price -f json
opencli aa flights SFO DFW 2026-11-13 --miles --fare main --max-miles 30000 --stops nonstop
opencli aa flights JFK LHR 2026-11-13 --return 2026-11-20 --adults 2 --miles --fare business -f json
opencli aa flights JFK LHR 2026-11-13 --return 2026-11-20 --fare premium --max-price 6000
opencli aa flights LAX MIA 2026-11-13 --stops one-or-fewer --max-duration 600 --sort departure --limit 10
```

## Search conditions

| Option | Meaning |
| --- | --- |
| `--return DATE` | Round-trip search. Results describe outbound choices, with starting round-trip prices |
| `--miles` | AAdvantage award pricing instead of cash |
| `--adults N` | 1–9 adult passengers. Default: 1 |
| `--fare NAME` | Exact displayed fare group or cabin. Default: `all` |
| `--stops TYPE` | `any`, `nonstop`, `one-or-fewer`, or `two-or-fewer` |
| `--max-price USD` | Per-person displayed cash price ceiling. Cash searches only |
| `--max-miles N` | Per-person displayed miles ceiling. Requires `--miles` |
| `--max-duration N` | Outbound duration ceiling, in minutes |
| `--sort TYPE` | `best` preserves AA order. Also accepts `price`, `duration`, and `departure` |
| `--limit N` | 1–500 fare rows after filtering and sorting. Default: 20 |
| `--timeout N` | Result-loading deadline of 5–180 seconds. Default: 90 |

Cash fare filters are `main`, `main-extra`, `premium-economy`, and `premium`.
AA groups cash Business and First fares under Premium. The command does not infer a specific cabin from that group.
Award cabin filters are `main`, `premium-economy`, `business`, and `first`.
An unavailable fare or a filter with no matching offers produces no row.

Fare, stop, price, and duration filters apply locally to the displayed results, before sorting and limiting.
AA can limit or rank the displayed flights. This command does not claim to search every possible itinerary.
`displayed_flight_count` records the result count supplied by AA, not the number of returned fare rows.
Award price sorting compares miles first, then the cash taxes and charges.

## Price and itinerary scope

Each available cash fare group or award cabin produces one row per flight choice.

- `price` is the displayed USD cash fare. It is null for awards.
- `miles` is the displayed award amount as an integer. For example, `32.5K` becomes `32500`.
- `taxes` is the separate cash component displayed with an award, including any carrier charges. It is not another mileage price.
- Cash rows have `taxes=null`. The result page does not itemize cash-fare taxes separately.
- `price_display` preserves the original amount and cash component, without adding precision to rounded site prices.
- Prices remain **per passenger**, even with `--adults 2` or more. The command does not multiply them into a party total.
- Cash rows carry `fare_kind=fare_group_minimum`, not a specific ticket product selected from the fare drawer.

For one-way cash searches, `price_basis=per_person_one_way_starting` marks a fare-group minimum.
One-way award offers use `price_basis=per_person_one_way`.

For round trips, AA displays a round-trip price before the return flight is selected.
Rows use `result_type=outbound_option` and `price_basis=per_person_round_trip_starting_total_return_not_selected`.
Flight numbers, dates, times, duration, and stops describe **only the outbound itinerary**.
The price is a starting round-trip quote, not an outbound-only charge or a finalized round-trip ticket.
Open `search_url` to select flights and confirm the final price.

Departure and arrival clocks use airport-local time, in 24-hour format.
Arrival dates apply the day offset shown by AA, including overnight and international date-line changes.
`segments` preserves the displayed flight numbers, aircraft, and operating-carrier notices.
`search_url` recreates the search without including AA search-session identifiers.

## Browser requirements

Use an English-US aa.com session and a desktop browser at least 1024 pixels wide.
Both cash and award searches worked while signed out during validation.
If AA requires a login or presents an access challenge, resolve it in the browser and retry.
The command reports the failure instead of returning cash results for an award request.
It does not read or modify cookies, tokens, or authentication storage.

The loader verifies the rendered route, dates, adult count, trip type, and miles checkbox.
It waits for a stable result set that matches AA's displayed count.
Missing fields, altered searches, incomplete results, expired sessions, and unrecognized prices fail instead of producing partial prices.
AA can block repeated searches. Avoid rapid retries after an access-denied response.

For local CDP development:

```bash
opencli plugin install /absolute/path/to/opencli-plugins/aa
opencli --cdp-endpoint http://127.0.0.1:9222 aa flights SFO DFW 2026-11-13 --miles -f json
pnpm -C opencli-plugins/aa test
```

## Fixtures

The four fixture pairs contain sanitized result-page fragments captured on 2026-09-11.
They cover SFO–DFW one-way cash and miles, plus JFK–LHR round-trip cash and miles for two adults.
Each HTML fixture retains five flight choices and adjusts its displayed count to five.
Headers, selected search fields, flight cards, and prices remain. Account data, scripts, SVGs, and search-session identifiers are absent.

The test suite covers the pure parser, serialized DOM reader, loading state machine, and command registration.
DOM tests use the existing web workspace's jsdom development dependency. The plugin has no runtime dependencies beyond OpenCLI.
