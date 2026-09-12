# Raw page URLs reach GA4 unsanitized, with Enhanced Measurement owning page views

- **Status**: Accepted
- **Date**: 2026-08-11
- **Architecture**: [Observability](../architecture/observability.md)

## Context

Rome counts page visits on the dashboard, on every app, and on the public-access gateway page. The desktop shell runs that same dashboard, so it counts as the dashboard rather than as a fourth surface. Apps have no document of their own — every app surface renders inside the one `rome-web` shell. Instrumentation placed in that shell covers every app, including the ones an agent writes after this decision ships. The goal is raw visit counting with an [app visitor breakdown](../observability/app-visits.md). Funnels and session replay stay out of scope.

Rome puts meaning in the URL path. `/share/<token>` carries a bearer credential granting access to a shared chat. `/memory/<file>`, `/chat/<sessionId>`, and `/projects/<name>` carry personal metadata, and apps mint arbitrary sub-routes under their own ids. Any page-view report that includes the URL carries those values to Google and into the operator's GA property.

The two faces of this decision are one choice. GA4 Enhanced Measurement reads `location` itself on each history change, so a sanitizer written in Rome's code never sees that read. Cleaning the URL requires turning Enhanced Measurement's history tracking off and firing every page view by hand. Sanitization and manual page views stand or fall together.

The shell does not own every navigation. The app SDK calls `pushState` directly, so in-app navigation happens inside app bundles that the shell never mediates. Enhanced Measurement observes those calls because it hooks the History API, and a hook in Rome's router does not.

The mitigations that remain are GA-side configuration. The stream's "Redact data" setting covers enumerated query parameters and emails, and cannot touch path segments. Access to the GA property is restricted instead. Consent UI and GDPR posture are out of scope by product decision, which raises the stakes on raw URLs rather than lowering them. PR #1822 built the industry default — manual tracking plus a client-side sanitizer — before review rejected it.

This tag is a browser-side pipeline. The server-side OTEL pipeline described in [observability.md](../architecture/observability.md) is separate and unchanged by this decision.

## Decision

The GA4 tag reports raw page URLs, credentials and personal path segments included. The tag's `config` call keeps its defaults, so it fires the view for the initial document load, and GA4 Enhanced Measurement history tracking owns every view after that. No client code sanitizes a URL, and no client code fires a manual page view except the idle re-engagement view.

## Alternatives

- **Sanitize URLs in the client before GA sees them, the PR #1822 approach.** Rejected because Enhanced Measurement reads `location` on its own, so a sanitizer only takes effect on page views Rome fires by hand. Adopting it forces manual instrumentation across every navigation path, which is the cost this decision exists to avoid.
- **Fire manual page views on route change with Enhanced Measurement history tracking off, the standard SPA pattern.** Rejected because app surfaces navigate through the SDK's own `pushState` calls, which the shell's router never sees. The SDK also announces those navigations on an event the shell could subscribe to. That count reaches only apps whose every navigation goes through the SDK helper. An app that drives the History API itself would ship uncounted, and an agent writes apps without that knowledge.
- **Keep Enhanced Measurement on and add manual page views for the routes that matter.** Rejected because both fire on the same navigation and the visit count doubles. A count that is wrong by an unknown factor answers nothing.
- **Lean on GA's "Redact data" setting to strip the sensitive values.** Rejected because redaction operates on enumerated query parameters and emails only. The share token and the personal metadata live in path segments, which the setting cannot reach.
- **Move share tokens and personal identifiers out of the URL path first.** Rejected because that changes the share-link security posture and the routing contract, which is a far larger change than page counting. It stays the named trigger for revisiting this record.
- **Instrument each app surface separately so each app controls what it reports.** Rejected because an agent writes apps without analytics knowledge, so every new app would arrive uncounted. It also loads GA inside widget iframes, which counts a widget render as an app visit.
- **Derive visit counts from the server-side OTEL pipeline and ship no third-party tag.** Rejected because Caddy serves the SPA shell and the gateway page from disk. External visitors on published apps never reach Hono, so the server sees no document request to count.
- **Hold all collection until a consent UI ships.** Rejected because consent and GDPR posture are out of scope by product decision, so the gate would defer visit counting with no owner and no date.

## Consequences

One loader in the SPA covers the dashboard, the desktop shell, and every app that exists or gets written later, with no per-app work. The gateway is its own HTML document, so it carries the stock gtag snippet instead, and a single runtime env var governs both. In-app navigation counts through the SDK's `pushState` calls without a route hook. The analytics module stays small enough to read in one sitting, and emptying that env var turns the whole thing off.

The cost is that a Rome URL is now a value Google holds. A share token in a visited path is a live bearer credential sitting in a third-party analytics property, so read access to that property is a sensitive grant, not a reporting convenience. Any route that puts a secret or a personal identifier in its path inherits this exposure the moment someone visits it. Weigh that at route-design time, because no downstream code will scrub it.

Future diffs must respect four things. The Enhanced Measurement toggle for browser-history page changes stays on, the loader's `config` call keeps its page-view defaults, and no diff adds a manual `page_view` outside the idle re-engagement path. The loader stays gated on the top-level window, so a widget iframe never loads GA. A route that needs to keep a value out of GA keeps that value out of the path, rather than adding a sanitizer. Re-proposing client-side sanitization needs a successor record here, not a pull request.
