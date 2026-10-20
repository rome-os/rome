import { Hono } from "hono";
import { proveIdentity, type ProveIdentityResult } from "../../lib/instance-identity.js";
import { assembleDiagnosticBundle, type DiagnosticsDeps } from "../../lib/diagnostics.js";
import { readResourceReadings } from "../../lib/resource-readings.js";

// One-shot triage endpoint: a single GET that answers "is this Rome instance
// healthy, and which exact build/identity am I looking at?" without the
// operator having to hit /build-info, /system/upgrade/check, the DB, and the
// channel list separately. It aggregates the cheap, already-known signals into
// one verdict so an out-of-band probe (curl, uptime monitor, support triage)
// can read health at a glance.

// Verifying instance identity contacts Rome Cloud. Cap it so an unreachable or
// slow Rome Cloud degrades to `unreachable` instead of hanging the whole probe.
const INSTANCE_CHECK_TIMEOUT_MS = 5_000;

// The auth states that mean this instance is no longer valid — the only
// identity outcomes that should fail the verdict.
// `no_token` (not enrolled) and `unconfigured` (source/test build) are expected
// non-error states; `unreachable` is a transient miss, not an instance fault.
const FATAL_AUTH_STATES: ReadonlySet<ProveIdentityResult["status"]> = new Set([
  "revoked",
  "unknown",
]);

export function diagnosisRoutes(deps: DiagnosticsDeps): Hono {
  const app = new Hono();

  app.get("/diagnosis", async (c) => {
    // The local, network-free signals (build, db, apps, channels, uptime).
    const bundle = await assembleDiagnosticBundle(deps);
    // Memory and disk are pressure, not faults: they inform the guardian but
    // leave the verdict alone, so a probe that alarms on `degraded` stays quiet
    // while a heavy task merely runs.
    const resources = readResourceReadings();

    const auth = await proveIdentity({
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(INSTANCE_CHECK_TIMEOUT_MS) }),
    });
    // `auth` is the single source of truth for enrollment: the full identity
    // status (no_token / unconfigured / unreachable / revoked / unknown / ok)
    // says more than a derived boolean could, so no `enrolled` flag.
    const instance = {
      auth: auth.status,
      accountId: auth.status === "ok" ? auth.identity.accountId : null,
      instanceId: auth.status === "ok" ? auth.identity.instanceId : null,
    };

    const healthy =
      bundle.database.ok &&
      !FATAL_AUTH_STATES.has(auth.status) &&
      bundle.apps.failed.length === 0 &&
      bundle.apps.broken.length === 0;

    return c.json({
      status: healthy ? "ok" : "degraded",
      checkedAt: new Date().toISOString(),
      uptimeSeconds: bundle.uptimeSeconds,
      build: bundle.build,
      upgradedSinceLastBoot: bundle.upgradedSinceLastBoot,
      previousVersion: bundle.previousVersion,
      instance,
      database: bundle.database,
      relay: bundle.relay,
      channels: bundle.channels,
      apps: bundle.apps,
      resources,
    });
  });

  return app;
}
