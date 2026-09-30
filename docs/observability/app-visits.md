# App visit analytics

The `rome_app_open` event carries `app_id`, `surface`, and `visitor_email`.
The surfaces are `embedded`, `full`, and `inline`.
The [page-view decision](../adrs/raw-analytics-urls-over-client-side-sanitization.md) governs the GA loader and widget exclusion.

The app manifest supplies the authenticated caller identity for each mount.
The event records the verified visitor email or the cloud guardian email when available.
A guardian session takes precedence when both guardian and visitor sessions are present.
Anonymous callers and local guardian accounts without an email use `guest`.
The value belongs to each event, so one app open cannot carry identity into another.

The Rome Cloud admin table groups opens by app and visitor from the GA BigQuery export.
Each app total includes all visitor groups, and the table ranks apps by that total.
Events without `visitor_email` count toward `guest`.
Email attribution starts when the instance runs an instrumented version. Historical events cannot recover an email.
