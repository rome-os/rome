# Southwest flights

`opencli southwest flights FROM TO DEPART` reads Southwest cash fares or Rapid Rewards awards from the browser.
`FROM` and `TO` are three-letter airport codes. `DEPART` and `--return` use `YYYY-MM-DD`.
Southwest validates airport service, origin-local travel dates, and its booking window.

```bash
opencli southwest flights OAK HOU 2026-11-13 -f json
opencli southwest flights OAK HOU 2026-11-13 --miles --stops nonstop -f json
opencli southwest flights DAL DEN 2026-12-08 --points --max-points 20000 --fare choice --sort price
opencli southwest flights OAK HOU 2026-11-13 --return 2026-11-20 --adults 2 --max-price 300
opencli southwest flights HOU CUN 2026-11-13 --miles --max-miles 30000 --limit 5
```

## Search options

| Option | Default | Meaning |
| --- | --- | --- |
| `--miles`, `--points` | Off | Either flag selects Rapid Rewards points. These are aliases, not separate currencies |
| `--return DATE` | None | Request a round-trip search and return its outbound options |
| `--adults N` | `1` | Search for 1–8 adult passengers |
| `--fare NAME` | `all` | `basic`, `choice`, `choice-preferred`, `choice-extra`, or `all` |
| `--stops NAME` | `any` | `nonstop`, `one-or-fewer`, `two-or-fewer`, or `any` |
| `--max-price USD` | None | Cash fare ceiling per person, including government taxes and fees |
| `--max-points N`, `--max-miles N` | None | Award points ceiling per person. Supply only one alias |
| `--max-duration MINUTES` | None | Maximum outbound duration |
| `--sort NAME` | `best` | Southwest order, `price`, `duration`, or `departure` |
| `--limit N` | `20` | Maximum 1–500 fare rows, after filtering and sorting |
| `--timeout SECONDS` | `90` | Result-loading deadline of 5–180 seconds |

Filters apply locally to the complete loaded flight matrix. `--sort price` orders awards by points, then cash taxes, without combining those units.
A stop without a plane change still counts as a stop. `plane_changes` distinguishes these direct flights from connections.

## Result contract

The command returns one row per available flight and fare product. A flight with all four products creates four rows before filtering.
Unavailable products do not become zero-dollar or zero-point fares.

- `price` is the displayed cash fare in USD. Southwest rounds displayed cash fares up to the nearest dollar, which `cash_price_rounded_up` records.
- `points` is the Rapid Rewards redemption amount. `price` is null for awards, even when the caller uses `--miles`.
- `taxes` is the displayed additional cash amount for awards. It is not inferred or fixed at $5.60, and international taxes can differ.
- `currency=USD` describes `price` and `taxes`, not `points`. Cash fares include government taxes and fees. Award points exclude the separately reported taxes.
- `price_basis=per_person_each_way` applies to every row. Prices are not multiplied by `--adults` and are not round-trip totals.
- A round-trip search returns `result_type=outbound_option`. The command does not select an outbound fare or inspect dependent return options.
- `departure_at` and `arrival_at` retain airport-local dates, times, and UTC offsets. Flight component data supplies the arrival date, including overnight flights without a next-day badge.
- `segments`, `flight_numbers`, `connection_airports`, `plane_changes`, `stops`, and `duration_minutes` describe the outbound itinerary.
- `seats_left` preserves the displayed fare inventory hint when present. Null means Southwest did not display a count.
- `search_url` opens the same search. Prices can change before booking. Optional baggage, seat, and other extras are not added.

Use `-f json` or `-f yaml` for the complete result. Table output shows the main flight and pricing fields.

## Browser requirements and failure behavior

Use Southwest in English with a desktop-width browser that displays all four fare products.
Public cash and award searches work without signing in. If Southwest requests a login, sign in manually in the browser and retry.

The command uses the persistent browser session without reading or changing cookies, credentials, or authentication storage.
It opens a fresh search page, reads rendered fare controls, and allowlists flight data from the matrix and row React components.
It verifies the route, dates, passenger count, currency, per-person scope, displayed times, and complete row count before returning prices.
It waits for two matching complete snapshots and retains the largest observed flight count during loading.

Access challenges, provider errors, missing component data, incomplete fare columns, or changed search conditions produce errors instead of partial prices.
The command does not call private APIs, click fare-selection buttons, add flights to a cart, or book travel.
Cash + Points, children, lap infants, promo codes, nearby-airport expansion, and multi-city searches are not supported.

## Install and test

```bash
opencli plugin install /absolute/path/to/opencli-plugins/southwest
opencli southwest flights --help
opencli validate southwest
pnpm -C opencli-plugins/southwest test
```

When Browser Bridge is unavailable, use the browser CDP endpoint:

```bash
opencli --cdp-endpoint http://127.0.0.1:9222 southwest flights OAK HOU 2026-11-13 --miles -f json
```

The tests reuse the web workspace's `jsdom` development dependency and run through `scripts/test-env.sh`.
CI runs the Southwest tests in its lint job after installing workspace dependencies.
