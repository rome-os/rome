# OpenCLI plugins

Rome-owned extensions to [OpenCLI](https://github.com/yunfanye/opencli) (`@yunfanye/opencli`),
shipped via OpenCLI's built-in plugin system instead of patching the installed package. Fork syncs
are a plain version bump of the globally installed CLI (`Dockerfile`, `infra/rome/Dockerfile`) -
no merge conflicts, ever.

## Layout

Mirrors upstream's `clis/<site>/<command>.js`:

```
opencli-plugins/
  google/
    opencli-plugin.json
    package.json
    flights.js        # google flights FROM TO DEPART [--return DATE] ...
  twitter/            # one OpenCLI plugin per site directory
    opencli-plugin.json   # name MUST be "rome-<site dir>" (the install loops derive
                          # the ~/.opencli/plugins link path from that convention)
    package.json          # {"type": "module"} — the repo root package.json is not ESM
    follow.js             # one command per file, flat inside the site dir
```

OpenCLI discovers plugin command files **flat** (no nested subdirectories inside a plugin), and
local installs of monorepo-manifest plugins are not supported in 1.8.6 — which is why each site
directory is its own standalone plugin rather than one plugin holding `<site>/<command>` trees.

## How it works

- `opencli plugin install <dir>` symlinks a plugin directory into `~/.opencli/plugins/<name>`
  (name from `opencli-plugin.json`). Because it is a symlink, source edits are picked up by the
  next `opencli` invocation — no reinstall, no rebuild.
- OpenCLI discovers commands at every CLI startup in this order: built-in adapters → user
  adapters → **plugins**. The registry is keyed by `site/name` with last-write-wins, so a plugin
  `cli()` call with an existing key (e.g. `twitter/follow`) replaces exactly that one command;
  all other commands under the same site remain built-in.
- Command files are plain ESM `.js` calling `cli()` from `@jackwener/opencli/registry`. The
  forked installer still symlinks the host opencli package into each plugin's `node_modules` at
  that compatibility path, so those imports resolve against the running `@yunfanye/opencli` CLI.

## Install points (all idempotent)

- **Production image**: `docker-entrypoint.sh` installs every `/app/opencli-plugins/*/` dir for
  the `rome` user after the `/app` sync. The symlinks survive image upgrades; rsync updates the
  plugin source in place.
- **Dev stack**: `scripts/dev-up.sh` (step 4c) installs every `/workspace/opencli-plugins/*/`
  dir inside the rome container (`HOME=/rome-home`, a persistent volume). Host edits flow
  through the mutagen sync into the symlinked source.

Agents pick up new/changed commands automatically: the `browser-automation` skill has them run
`opencli <site> --help` before use, and plugin commands appear there like any built-in.

## Rome-owned commands

- `opencli chatgpt memory` — opens Personalization > Memory summary in the signed-in ChatGPT
  browser session and returns each learned-memory section with its last-updated label.
- `opencli chase accept-offers -f json` — accepts every available Chase Offer across all credit
  cards in the signed-in browser session and returns card, reward, expiration, category, location,
  merchant-site, and full offer-detail fields. It uses Chase's own rendered offer controls rather
  than handling authentication tokens or calling private endpoints directly.
- `opencli twitter follow-status <username>` — reports the current follow relationship.
- `opencli twitter follow <username> [--only-follow-back]` — follows a Twitter account, with an
  optional follow-back guard.
- `opencli twitter follow-network <username> <followers|following> [--limit N]` — follows accounts
  directly from a user's followers or following page and returns only the accounts newly followed.
- `opencli linkedin contact-info <profile>` — opens a LinkedIn profile's Contact info section and
  returns every field visible to the signed-in account, including websites, email addresses,
  phone numbers, addresses, birthdays, connected dates, and other displayed contact fields.
- `opencli linkedin thread-snapshot --thread-url URL [--limit N]` — returns the latest messages
  from one exact LinkedIn thread with sender, timestamp, profile, participant id, and reaction
  metadata.
- `opencli linkedin thread-participants --thread-url URL` — returns one row per participant of an
  exact LinkedIn thread, including participants who have never sent a message.
- `opencli craigslist locations [QUERY]` — discovers site codes from Craigslist's worldwide
  directory; `categories --site SITE` lists the category codes available at that site.
- `opencli craigslist search [QUERY] --site SITE [options]` — searches public listings across
  for-sale, housing, jobs, gigs, services, community, and events with common and category-specific
  filters; `listing URL` reads a result's complete public details.
- `opencli google jobs QUERY [options]` — searches Google Jobs with composable location, remote,
  employment-type, recency, company, source, salary-presence, and sorting filters. Optional detail
  loading adds the full job description and direct application links.
- `opencli yelp search QUERY --location LOCATION [options]` — searches public Yelp business results
  with composable category, price, hours, service, feature, quality, sponsored-result, and sort
  controls.
- `opencli yelp business|reviews|photos|menu BUSINESS [options]` — resolves a business name, Yelp
  alias, or Yelp URL and reads its public details, reviews, categorized photos, and menu/popular-item
  information without requiring a Yelp login.
- `opencli opentable search [QUERY] --location LOCATION --date DATE [options]` — searches public
  OpenTable availability with date, time, party-size, cuisine, neighborhood, price, seating,
  accessibility, quality, experience, and sorting controls.
- `opencli opentable restaurant|availability|reviews|menu|photos|experiences BUSINESS [options]` —
  resolves a restaurant name, OpenTable alias, or `/r/` URL and reads its public profile,
  bookable times and booking links, verified reviews, menus, photos, and dining experiences without
  requiring an OpenTable login.
- `opencli redfin download URL [--output DIR] [--size SIZE] [--limit N]` — downloads every gallery
  photo of a public Redfin listing into one folder per listing, in gallery order, with captions and
  room tags in the result rows. `photos URL` lists the same gallery without writing anything.
- `opencli zillow download URL [--output DIR] [--size SIZE] [--limit N]` — downloads every gallery
  photo of a public Zillow listing into one folder per listing, in gallery order, at the widest
  original-ratio size Zillow serves. `photos URL` lists the same gallery without writing anything.
- `opencli gemini video PROMPT [--image A.jpg,B.jpg] [--ratio 16:9|9:16] [--output DIR] [--name FILE]`
  — generates a clip in the signed-in Gemini web session's video composer, optionally animating
  uploaded photos, waits for the render, and saves the MP4 with the browser's session cookies.

## Overriding a built-in command: caveats

- Redeclare any `aliases` the built-in had — replacing a registry key drops the old entry's
  aliases.
- Overrides shadow upstream silently after version bumps. When bumping `@yunfanye/opencli`,
  diff each override against its upstream source (noted in a comment at the top of each file)
  and port relevant fixes.

## Adding a command

- **Existing site dir**: drop another `.js` file next to its siblings calling
  `cli({ site, name, ... })` — a new `name` adds a command, an existing built-in `site/name`
  overrides it.
- **New site**: copy an existing site dir (manifest name `rome-<site>`, `package.json` with
  `"type": "module"`) and add command files. The install loops discover any
  `opencli-plugins/*/opencli-plugin.json` automatically.

Re-run `pnpm dev:all` (or wait for the next boot in prod) to register a new site dir;
already-installed symlinks pick up file changes immediately.

### ChatGPT Memory

The ChatGPT plugin adds a read-only `memory` command that uses the rendered Personalization UI.
It opens **Memory summary > Manage**, then returns one row per visible summary section. The command
does not call ChatGPT's private APIs or read authentication tokens. ChatGPT controls whether the
Memory summary feature and its sections are available to the signed-in account.

```bash
opencli chatgpt memory
opencli chatgpt memory -f json
```

### Twitter Follow Network

The Twitter plugin can follow accounts directly from another user's rendered followers or
following page. It clicks the inline Follow controls, scrolls the list as needed, skips accounts
that are already followed, and returns only accounts whose new follow state was verified. `--limit`
caps the number of new follows rather than the number of list rows inspected.

```bash
opencli twitter follow-network @realYunfanYe followers --limit 10 -f json
opencli twitter follow-network @realYunfanYe following --limit 10
```

### LinkedIn Contact Info

The LinkedIn plugin adds a browser-backed, read-only contact reader for the signed-in LinkedIn
account. It accepts a full `/in/` profile URL, `/in/` path, `@public-id`, bare public identifier, or
`me`, then opens that profile's Contact info overlay. Each visible contact value is returned as a
typed row with its display label and safe link where one exists.

LinkedIn controls which fields the signed-in account may see. A profile with no shared contact
details, a private contact section, or a missing/restricted profile returns a status row instead of
failing or pretending that hidden data is available. Authentication walls still produce the
standard OpenCLI authentication error.

```bash
opencli linkedin contact-info satyanadella -f json
opencli linkedin contact-info @satyanadella
opencli linkedin contact-info "https://www.linkedin.com/in/satyanadella/" -f yaml
opencli linkedin contact-info me -f json
```

### LinkedIn Thread Snapshot

The LinkedIn plugin replaces the DOM-based thread snapshot with a thread-scoped reader. It joins
the normalized message response with the requested conversation from LinkedIn's normalized inbox
response. It resolves the conversation's participant references, then verifies every returned
message against the requested thread ID. Other conversations, conversation-list previews, and
duplicate wrapper nodes never enter the result.

The command returns one row per message in chronological order. `--limit` selects the latest 1 to
100 messages and defaults to 20. Each row includes the sender, sender profile, self/other direction,
delivery time, stable message ID, subject, and reaction count.

`sender_participant_id` carries LinkedIn's obfuscated member id for the sender — the bare `ACoAA…`
segment that also sits inside `sender_profile_url` — so a caller can use it as a stable
`channel_user_id`. It is empty when the sender is not among the participants the response resolved.

`conversation_name` is a display ladder — the conversation title when LinkedIn has one, else the
joined counterparty names — so a 1:1 thread carries the counterparty's name there and the field is
never a group signal. Group-ness rides separately: `conversation_is_group` reads the API's own
`groupChat` flag, then falls back to a complete participant list when the flag is absent.
`conversation_title` carries the raw title only. `participant_count` counts every participant,
including the account owner. Sparse message data leaves unknown metadata empty instead of
mislabeling the conversation as 1:1.

```bash
opencli linkedin thread-snapshot --thread-url "https://www.linkedin.com/messaging/thread/2-.../"
opencli linkedin thread-snapshot --thread-url "https://www.linkedin.com/messaging/thread/2-.../" --limit 50 -f json
```

### LinkedIn Thread Participants

`thread-participants` answers "who is on this thread" directly. It shares `thread-snapshot`'s read
path — same navigation, same thread-identity check, same two normalized messaging endpoints — and
returns one row per participant instead of one row per message.

The conversation response is the authoritative source, because its participant reference list names
everyone on the thread including members who have never sent a message. When that metadata is
unavailable, the command falls back to the participants the message response proves and reports
those rather than failing. A 1:1 thread returns both the account owner (`is_self`) and the
counterparty.

Each row carries `participant_id`: LinkedIn's obfuscated member id, emitted bare so it can be used
as a `channel_user_id`. Like `thread-snapshot`, the command fails closed on an authentication wall
and when the browser did not land on the exact requested thread.

```bash
opencli linkedin thread-participants --thread-url "https://www.linkedin.com/messaging/thread/2-.../"
opencli linkedin thread-participants --thread-url "https://www.linkedin.com/messaging/thread/2-.../" -f json
```

### Craigslist

The Craigslist plugin covers the popular public, signed-out workflow without relying on a default
city or a hard-coded category catalog:

- `locations` searches Craigslist's worldwide site directory and returns the site code accepted by
  the other commands.
- `categories` reads a site's current top-level and leaf categories, including each three-character
  code and group.
- `search` browses or searches any category. It supports common price, image, recency, seller,
  postal-radius, and duplicate filters; housing, job, and vehicle filters; deterministic limits and
  price sorts; plus `--params` for category-specific Craigslist query parameters.
- `listing` reads the full description, dynamic attributes, timestamps, images, breadcrumbs,
  seller type, public reply availability, and map coordinates from a search result URL.

All four commands are browser-backed and read-only. They use only public pages and never require a
Craigslist account.

```bash
opencli craigslist locations "san francisco" -f json
opencli craigslist categories --site sfbay --group housing
opencli craigslist search "road bike" --site sfbay --category bicycles --max-price 800 --has-image
opencli craigslist search --site newyork --category apartments --max-price 3500 --cats-ok --posted-today
opencli craigslist search "machine learning" --site sfbay --category jobs --remote --sort newest
opencli craigslist listing "https://www.craigslist.org/view/d/..." -f json
```

### Google Flights

The Google plugin adds a browser-backed, read-only flight search command. It accepts airport
codes, cities, or airport names, supports one-way and round-trip dates, cabin/passenger settings,
and can filter or sort the returned flight choices without clicking into a booking flow.

One-way searches return complete one-way itinerary choices. For a round-trip search, Google first
shows **outbound options only** and does not reveal the return choices until an outbound flight is
selected. Accordingly, each row is labeled `result_type=outbound_option`: every `leg_*` field and
the airline/stops/duration/emissions filters describe only that outbound leg, while `price` is
explicitly labeled `price_basis=round_trip_starting_total_return_not_selected`. It is not a
finalized round-trip itinerary; follow the returned Google Flights URL to select the return leg.

```bash
opencli google flights SFO LAX 2026-08-10 --return 2026-08-17 --limit 5
opencli google flights "San Francisco" Tokyo 2026-09-08 --cabin business --sort price -f json
opencli google flights JFK LHR 2026-10-01 --stops nonstop --max-price 900 --airline "Delta,Virgin"
```

### Google Shopping

The Google plugin also adds a browser-backed product search and comparison command. It reads the
rendered Google Shopping page, returns both product cards and sponsored merchant offers, and can
compose client-side price, merchant, rating, condition, sale, delivery, and sponsored-result
filters. Page relevance is preserved by default; deterministic price, rating, review-count, and
discount sorts are available when comparison matters more than Google's ordering.

```bash
opencli google shopping "noise cancelling headphones" --max-price 300 --min-rating 4.5
opencli google shopping "4k monitor" --merchant "Best Buy,Target" --sort price-low -f json
opencli google shopping "standing desk" --on-sale --free-shipping --sponsored exclude --limit 20
```

### Google Jobs

The Google plugin adds a browser-backed job search command over Google's dedicated Jobs result
vertical. It preserves Google's relevance order by default, can compose both search-side query
constraints and deterministic client-side filters, and exposes structured salary, posting age,
employment type, source, and stable job-id fields. Use `--details` (with at most 10 results) when
you also need full descriptions, an exact Google detail URL, and every direct application option.

```bash
opencli google jobs "staff software engineer" --location "San Francisco, CA" --posted-within week
opencli google jobs "machine learning engineer" --remote only --job-type full-time --sort recent -f json
opencli google jobs "product designer" --company "Figma,Adobe" --exclude-source LinkedIn --has-salary
opencli google jobs "developer advocate" --location London --details --limit 3 -f json
```

### Google Maps

The Google plugin adds a browser-backed Maps command organized around four explicit operations:

- `search` returns ranked place cards and supports a location hint, open/rating/review filters,
  deterministic rating/review sorts, and up to 50 results.
- `place` resolves the top matching place (or an exact `--place-id`) and returns its address,
  coordinates, category, rating, hours, phone, website, price level, and Plus Code when Google
  displays them.
- `reviews` resolves a merchant or exact `--place-id`, opens Google Maps' public review panel,
  expands truncated reviews, and returns review text, rating, displayed date, reviewer metadata,
  likes, photo count, and owner responses. Hotel panels are narrowed to their Google source rather
  than mixing in third-party booking-site reviews. The operation supports Google's
  relevant/newest/highest/lowest sorts when the panel exposes them, plus an exact star-rating
  filter and up to 50 results.
- `directions` compares route alternatives for driving, walking, bicycling, two-wheelers, or
  transit. It supports precise origin/destination Place IDs, ordered waypoints, and avoiding
  ferries, highways, or tolls through Google's standard Maps URL parameters.

```bash
opencli google maps search coffee --near "Ferry Building, San Francisco" --open-now --min-rating 4.5
opencli google maps place "Ferry Building, San Francisco" -f json
opencli google maps reviews "Ferry Building, San Francisco" --review-sort newest --limit 10 -f json
opencli google maps reviews "Ferry Building, San Francisco" --review-sort lowest --rating 1 -f json
opencli google maps directions "Ferry Building, San Francisco" --to "Golden Gate Bridge" --travel-mode bicycling
opencli google maps directions Paris --to Cherbourg --waypoints "Versailles|Chartres|Le Mans" --avoid tolls
```

### Yelp

The Yelp plugin covers the main logged-out discovery flow with five read-only commands:

- `search` supports a required location plus Yelp category aliases, four price levels, open-now or
  open-at availability, delivery/takeout/reservation/waitlist services, common accessibility and
  amenity features, rating/review thresholds, sponsored-result policy, pagination, and Yelp's
  recommended/rating/review-count/distance sorts.
- `business` returns rating and review count, price, categories, claim and current-open state, full
  weekly hours, address and neighborhood, phone, website and menu links, active amenities, health
  score, description, primary photo, and stable Yelp identifiers.
- `reviews` supports Yelp's recommended/newest/oldest/highest/lowest sorts, star-rating and keyword
  filters, and pagination while returning full public review text, author metadata, photos, and
  reaction counts.
- `photos` reads up to 30 current gallery items from the all, drink, inside, food, outside, or menu
  tabs with original and thumbnail URLs plus captions, authors, and dates.
- `menu` returns Yelp-hosted menu items when present, otherwise Yelp's popular dishes/drinks with
  photo/review counts, and always includes Yelp's external menu link when available.

Business-taking commands accept an exact Yelp alias or `/biz/` URL. A plain business name is also
supported when paired with `--location`, which makes resolution deterministic.

```bash
opencli yelp search "tacos" --location "San Francisco, CA" --prices 1,2 --open-now --min-rating 4
opencli yelp business "The Coffee Movement" --location "San Francisco, CA" -f json
opencli yelp reviews the-coffee-movement-san-francisco-4 --sort newest --rating 5 --limit 10
opencli yelp photos the-coffee-movement-san-francisco-4 --category food --limit 10 -f json
opencli yelp menu house-of-prime-rib-san-francisco --query cut -f json
```

### OpenTable

The OpenTable plugin covers the popular signed-out discovery and restaurant-research workflow:

- `search` resolves OpenTable's public location autocomplete and searches by date, local time, and
  party size. It supports visible cuisine, neighborhood, price, seating, top-rated, and wheelchair
  filters; client-side rating/review/availability filters; deterministic sorts; and up to 50 rows.
- `restaurant` reads the public overview and practical details such as hours, address, contact
  information, cuisines, dining style, dress code, and amenities.
- `availability` reads displayed time slots, seating type, experience, price/policy details, and
  the direct OpenTable booking link. It does not submit a reservation or collect guest details.
- `reviews`, `menu`, `photos`, and `experiences` cover the other public profile sections with
  focused filters and stable structured output.

All commands are browser-backed and require no OpenTable account. They use OpenTable's visible UI
and structured page data rather than its token-protected Consumer API. When OpenTable presents an
Akamai/CAPTCHA challenge, commands fail with a typed error instead of returning partial rows.

```bash
opencli opentable search italian --location "San Francisco, CA" --date 2026-07-18 --time 19:00 --party-size 2
opencli opentable search --location Manhattan --date 2026-07-19 --prices 2,3 --seating outdoor --min-rating 4.5
opencli opentable restaurant lolinda-reservations-san-francisco -f json
opencli opentable availability lolinda-reservations-san-francisco --date 2026-07-19 --time 19:00 --party-size 2
opencli opentable reviews lolinda-reservations-san-francisco --sort newest --rating 5 --limit 10
opencli opentable menu lolinda-reservations-san-francisco --query steak -f json
opencli opentable photos lolinda-reservations-san-francisco --category food --limit 10
opencli opentable experiences lolinda-reservations-san-francisco -f json
```

### Redfin

The Redfin plugin reads a public listing page and works from the gallery Redfin server-renders into
the page state (`__reactServerState`), which lists every photo in display order with the CDN URL of
each size variant, plus Redfin's own captions and room tags per photo. The commands need no Redfin
account and call no private API. When that state is absent, the commands fall back to the full-size
CDN URLs present in the HTML.

- `download` saves the gallery to `<output>/<address slug>-<property id>/`, one file per photo named
  `<gallery position>-<CDN file name>` (for example `01-ML82027150_2.jpg`) so a folder listing
  matches the order on Redfin. Each result row carries the saved path, byte size, caption, tags,
  and source URL. A photo that fails to download gets a failed row with the error, and the run
  continues with the next photo.
- `photos` returns the same gallery as rows without touching the disk.
- `--size` picks the variant. `full` (default) is Redfin's uncropped full-screen image, up to 1280px
  wide. `large` is a fixed 1080×771 crop. `medium`, `small`, and `thumb` are progressively smaller.
  Files for a non-default size carry the size in their name, so variants never overwrite each other.
- `--limit` caps the number of photos taken from the front of the gallery.

A Redfin bot-check ("Press & Hold") or a missing listing fails with a typed error instead of an empty
result.

```bash
opencli redfin download https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461
opencli redfin download https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461 --output ~/Pictures --size large --limit 10 -f json
opencli redfin photos https://www.redfin.com/CA/Atherton/349-Walsh-Rd-94027/home/1061461 -f json
```

### Zillow

The Zillow plugin reads a public home details page and works from the Next.js page state Zillow
server-renders into `<script id="__NEXT_DATA__">`. The `gdpClientCache` entry there holds the
listing's `responsivePhotosOriginalRatio` list: every photo in display order with the CDN URL of
each width bucket, plus a caption and subject type when the listing has them. The commands need no
Zillow account and call no private API. When that state is absent, the commands fall back to the
CDN URLs present in the HTML.

- `download` saves the gallery to `<output>/<address slug>-<zpid>/`, one file per photo named
  `<gallery position>-<photo key>.jpg` (for example `01-40a2df03a9e1e7ce67de59c614683f5f.jpg`) so
  a folder listing matches the order on Zillow. Each result row carries the saved path, byte size,
  caption, subject type, served width, and source URL. A photo that fails to download gets a failed
  row with the error, and the run continues with the next photo.
- `photos` returns the same gallery as rows without touching the disk.
- `--size` picks the width bucket. `full` (default) is the widest original-ratio bucket, up to
  1536px wide, which Zillow scales down from the source photo and never scales up. `large` (1344),
  `medium` (1024), and `small` (800) are the narrower original-ratio buckets. `thumb` is Zillow's
  384px crop. A bucket the listing does not publish falls back to the nearest one it does. Files
  for a non-default size carry the size in their name, so variants never overwrite each other.
- `--limit` caps the number of photos taken from the front of the gallery.

Both a canonical `/homedetails/<address>/<zpid>_zpid/` URL and a `/homes/<address>_rb/` address
URL work. The address form resolves through a Zillow redirect, so the canonical form is faster.

Zillow's PerimeterX sensor scores each page load and stores its verdict in the `_px*` and `pxcts`
cookies. A verdict written during an automated load blocks the next load with a "Press & Hold"
wall or a bare HTTP 5xx. When a command hits either, it deletes only those PerimeterX cookies from
the browser, which resets the verdict, and loads the page once more. Every other Zillow cookie,
including a signed-in session, stays in place. A wall that survives the retry fails with a typed
error, as does a missing listing.

```bash
opencli zillow download https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/
opencli zillow download https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/ --output ~/Pictures --size large --limit 10 -f json
opencli zillow photos https://www.zillow.com/homedetails/349-Walsh-Rd-Atherton-CA-94027/15598337_zpid/ -f json
```

### Gemini video

The Gemini plugin adds `video` next to the built-in `ask` and `image` commands. It opens
`gemini.google.com/videos`, where Gemini pre-selects its Videos tool, picks the aspect ratio,
attaches any `--image` files, submits the prompt, polls the newest model turn until a player
renders or Gemini reports a failure, then downloads the MP4. The clip host refuses anonymous
requests, so the download forwards the browser's Google session cookies for that host only.

- `--image` takes a comma-separated list of local paths (up to 10). Gemini builds its file input
  on demand and only a trusted pointer click opens it, so the command intercepts the file chooser
  over CDP and hands Chrome the paths. That needs the direct CDP backend
  (`opencli --cdp-endpoint http://127.0.0.1:9222 …`); the Browser Bridge extension does not
  relay CDP events. The command waits for every attachment tile to finish uploading before it
  sends, because a message sent mid-upload is dropped without an error.
- One prompt yields one clip of roughly 8 to 10 seconds at 1280×720 with generated ambient
  audio. Longer films are several runs stitched together.
- Gemini enforces a daily video allowance per account (Google AI Pro: 3 videos a day). Once it is
  spent, Gemini locks the video composer without a message; the command reports that state as a
  typed error instead of waiting for a clip.
- A refusal ("I can't generate that video") is returned as a typed error with Gemini's wording.
  Refusals are often transient; a retry with a simpler prompt usually works.

```bash
opencli --cdp-endpoint http://127.0.0.1:9222 gemini video "Slow cinematic dolly toward the house at dusk, subtle motion" --image ./front.jpg --output ./clips --name front-dusk
opencli --cdp-endpoint http://127.0.0.1:9222 gemini video "A paper boat drifting on a pond at sunrise" --ratio 9:16 -f json
```
