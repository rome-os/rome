import type { AgentReporter } from "./feedback-client.js";
import type { DiagnosticBundle } from "./diagnostics.js";

// Shared shape + limits for the "share feedback" feature.
//
// The web client sends `{ body, client }`; the instance enriches it with
// server-assembled diagnostics and relays `{ schemaVersion, body, payload }` to
// Rome Cloud. The two payload namespaces preserve provenance and the trust
// boundary: `client` is reporter-supplied (browser or agent input, untrusted,
// open-ended), `diagnostics` is instance-owned (measurements and runtime-set
// reporter provenance) and must NEVER be populated from model or browser input
// — that is what makes spoofing the trusted namespace structurally impossible.
//
// `schemaVersion` is bumped only on a breaking reshape; additive fields under
// either namespace need no bump. Rome Cloud preserves these record namespaces
// but strips unknown keys directly under payload, so reporter belongs in diagnostics.

export const FEEDBACK_SCHEMA_VERSION = 1;

// Caps so a single report can't bloat the relay or the Rome Cloud row. Mirrored
// (more loosely) on the Rome Cloud edge, which can't trust instance-side checks.
export const FEEDBACK_BODY_MAX = 4_000;

export interface FeedbackReport {
  schemaVersion: number;
  body: string;
  payload: {
    /** Reporter-supplied context (browser or agent input). Untrusted. */
    client: Record<string, unknown>;
    /** Instance-owned measurements and runtime provenance; never from model or browser input. */
    diagnostics: DiagnosticBundle & {
      reporter: { kind: "guardian" } | AgentReporter;
    };
  };
}
