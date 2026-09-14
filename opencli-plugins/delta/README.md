# Delta flights

Search [Delta](https://www.delta.com/flightsearch/book-a-flight) for cash fares or SkyMiles awards through its public booking form and rendered results.
The command never selects a flight or creates a booking.

```bash
opencli delta flights SFO JFK 2026-11-13 -f json
opencli delta flights SFO JFK 2026-11-13 --miles --stops nonstop --sort price -f json
opencli delta flights SFO IAH 2026-11-13 --return 2026-11-20 --adults 2 -f json
opencli delta flights SFO JFK 2026-11-13 --miles --max-miles 50000 --cabin comfort
opencli delta flights SFO JFK 2026-11-13 --max-price 500 --max-duration 400
```

## Browser requirements

Use a desktop browser at least 1024px wide, with Delta set to **United States - English**.
OpenCLI reuses the current browser session. Delta decides whether a search needs SkyMiles sign-in.
If Delta asks for sign-in or an access challenge, complete it in the browser and retry.
The command does not bypass challenges, inspect credentials, change cookies, or substitute cash prices for unavailable awards.

When Browser Bridge is unavailable, use the direct CDP endpoint:

```bash
opencli --cdp-endpoint http://127.0.0.1:9222 delta flights SFO JFK 2026-11-13 --miles -f json
```

## Search conditions

| Argument | Meaning |
| --- | --- |
| `FROM TO DEPART` | Three-letter airport codes and an origin-local departure date in `YYYY-MM-DD` format |
| `--return DATE` | Return date. Results describe outbound choices, not a selected round trip |
| `--miles` | SkyMiles award search. Default is cash in USD |
| `--adults N` | 1–9 adult travelers. Prices stay per passenger |
| `--cabin CABIN` | `economy` (default), `comfort`, `premium-economy`, `business`, `first`, or `all` |
| `--stops STOPS` | `any` (default), `nonstop`, `one-or-fewer`, or `two-or-fewer` |
| `--max-price AMOUNT` | Maximum displayed cash price per passenger. Cash searches only |
| `--max-miles N` | Maximum standard award miles per passenger. Requires `--miles` |
| `--max-duration N` | Maximum outbound duration in minutes |
| `--exclude-mixed-cabin` | Exclude offers whose segments use different cabins |
| `--sort ORDER` | `best` (Delta order, default), `price`, `duration`, or `departure` |
| `--limit N` | Maximum fare rows, from 1–500. Default is 20 |
| `--timeout SECONDS` | Loading deadline, from 5–180 seconds. Default is 90 |

The search includes Basic fares and disables flexible dates, nearby airports, and refundable-only pricing.
Cabin, stop, price, and duration filters run after every result page has loaded.
`economy` maps to Delta Main, `comfort` to Delta Comfort, `premium-economy` to Delta Premium Select, and `business` to Delta One.
A mixed-cabin offer matches its highest cabin and carries `mixed_cabin: true`.
The actual fare product controls this mapping, not the column heading. Delta can show First fares under a Premium Select column.

## Price contract

Each output row describes one outbound itinerary and one available fare column.
`flight_numbers`, `connections`, local dates and times, duration, and stops describe the outbound itinerary.
Sold-out and not-offered cells do not produce rows. Rows include a reusable search URL and `retrieved_at` timestamp.

- Cash searches return `price` and `currency: "USD"`. The displayed cash price includes taxes and fees.
- Award searches return `miles` and separate cash `taxes`. `price` is null.
- Delta can round prices on the results screen. The command preserves the displayed amount, including rounded taxes, rather than inventing cents.
- Promotional card-member amounts remain separate in `card_member_miles`, `card_member_taxes`, and `card_member_offer`.
  These offers do not prove eligibility and never replace the standard award price.
- `--sort price` orders standard miles first and taxes second for awards. `--max-miles` filters standard awards, not card-member offers.
- One-way prices use `price_basis: "one_way_per_passenger"`.
- Round-trip outbound choices use `price_basis: "round_trip_per_passenger_starting_total"`.
  Delta can change that total after a return flight or fare variant is selected. The command does not quote a confirmed round trip.

The reader checks submitted search conditions against the displayed route, date, passenger count, and pricing mode before returning prices.
It reads only the flight conditions in Delta's search-specific `postData<cacheKeySuffix>` entry, not other browser storage.
Missing state, changed labels, incomplete pagination, and unexpected currencies produce errors rather than partial or mislabeled prices.

## Development

```bash
opencli plugin install /absolute/path/to/rome/opencli-plugins/delta
pnpm -C opencli-plugins/delta test
opencli validate delta
```

Tests cover argument validation, price scope, current versus promotional awards, mixed cabins, search verification, pagination, and DOM extraction.
The DOM fixtures contain flight-result fragments captured from Delta, without account information.
The DOM suite uses the web workspace's `jsdom` test dependency and adds no plugin runtime dependency.
