# Southwest fixtures

Captured on 2026-09-11 from Southwest's English desktop results for OAK–HOU on 2026-11-13.
The cash search has one adult and a 2026-11-20 return date. The points search has two adults and is one-way.

The cash and points HTML files retain only the route, currency controls, date strip, four flight rows, and the per-person fare note.
Their JSON files retain the reader's allowlisted flight fields. Account state, scripts, cookies, request headers, and storage are not captured.

The four rows cover a nonstop flight, a direct flight with a stop, an unavailable Basic fare, and an overnight connection.
The overnight row has a next-day arrival timestamp but no next-day display badge.
Counts reflect the four fixture rows rather than the full live matrix.

DOM tests attach the captured flight fields to minimal React-fiber fixtures.
Getters on unrelated fixture properties throw if the reader accesses them.
The calendar epoch is set to local midnight in the test runtime to match Southwest's browser-local date encoding.

`empty.html` is synthetic markup for the empty-results DOM tests.
`empty-matrix.json` models the allowlisted props from `renderPriceMatrixWithoutSearchResults` in [Southwest's frontend bundle](https://www.southwest.com/air/booking/static/112.0.3/js/app.js), inspected on 2026-09-11.
That renderer omits `details`. Tests attach the search query separately and exercise cash and points modes, loading, and inconsistent empty-state signals.
