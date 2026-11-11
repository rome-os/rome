import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getBuildInfo } from "../../build-info.js";
import { cloudBearer } from "../../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../../instance/rome-cloud-origin.js";
import type { SystemUpgradeService } from "../../instance/system-upgrade/service.js";

export interface SystemUpgradeRoutesDeps {
  systemUpgradeService: SystemUpgradeService;
}

// Dashboard-facing forwarders for the Rome Cloud self-upgrade contract. Core
// never decides upgrade policy itself: it relays the dashboard's request (from
// the guardian or a dashboard visitor, who may upgrade too) to Rome Cloud with
// the instance token and mirrors Rome Cloud's verdict (status code + body)
// back to the dashboard unchanged, so the dashboard sees one consistent
// contract regardless of which side rejected the request.
//
// The one local precondition besides Rome Cloud access: the running build must
// have a release version. An unversioned build (source run, test image) has no
// identity comparable against Rome Cloud's latest — a check would report an
// upgrade available forever, and the dashboard's post-upgrade probe could
// never observe the target version — so both verbs self-reject instead of
// relaying.

async function romeCloudAccess(): Promise<{ origin: string; token: string } | null> {
  const token = await cloudBearer();
  const origin = getRomeCloudOrigin();
  if (!token || !origin) return null;
  return { origin, token };
}

async function mirrorRomeCloudResponse(response: Response) {
  // Mirror status + JSON body verbatim. A non-JSON body on any status means
  // we didn't actually talk to Rome Cloud's contract — treat as unreachable
  // rather than inventing a success or empty payload.
  const body: unknown = await response.json().catch(() => null);
  if (body === null) return null;
  return { body, status: response.status as ContentfulStatusCode };
}

export function systemUpgradeRoutes(deps: SystemUpgradeRoutesDeps): Hono {
  const app = new Hono();
  const hub = deps.systemUpgradeService.getHub();

  // The banner's only read surface: it polls this snapshot (slow while idle,
  // fast during a countdown or restart). During the cutover the poll doubles as
  // the health probe — any 200 from the replacement process reports `idle`,
  // which is the banner's signal that the upgrade converged.
  app.get("/system/upgrade/status/snapshot", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(hub.getSnapshot());
  });

  // Consent verbs. Both are no-ops outside the countdown phase, so a double
  // click or a stale tab can't desync the hub — they just re-report status.
  // `now` relays the cutover to Rome Cloud before answering: a 200 snapshot with
  // phase `updating` is the ack that a restart is genuinely initiated, and a
  // Rome Cloud failure surfaces as an error with the countdown left standing.
  app.post("/system/upgrade/now", async (c) => {
    const result = await deps.systemUpgradeService.requestNow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(hub.getSnapshot());
  });

  app.post("/system/upgrade/defer", (c) => {
    deps.systemUpgradeService.requestDefer();
    return c.json(hub.getSnapshot());
  });

  app.get("/system/upgrade/check", async (c) => {
    const build = getBuildInfo();
    if (!build.version) return c.json({ error: "unversioned_build" }, 503);

    const romeCloud = await romeCloudAccess();
    if (!romeCloud) return c.json({ error: "pantheon_unconfigured" }, 503);

    const url = new URL("/api/instance/upgrade/check", romeCloud.origin);
    url.searchParams.set("version", build.version);
    url.searchParams.set("sha", build.sha ?? "");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${romeCloud.token}`, "Cache-Control": "no-store" },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return c.json({ error: "pantheon_unreachable" }, 502);
    }

    const mirrored = await mirrorRomeCloudResponse(response);
    if (!mirrored) return c.json({ error: "pantheon_unreachable" }, 502);
    return c.json(mirrored.body, mirrored.status);
  });

  app.post("/system/upgrade", async (c) => {
    if (!getBuildInfo().version) return c.json({ error: "unversioned_build" }, 503);

    const payload = await c.req.json<{ target?: unknown }>().catch(() => null);
    const target = typeof payload?.target === "string" ? payload.target.trim() : "";
    if (!target) return c.json({ error: "target_required" }, 400);

    const romeCloud = await romeCloudAccess();
    if (!romeCloud) return c.json({ error: "pantheon_unconfigured" }, 503);

    let response: Response;
    try {
      response = await fetch(new URL("/api/instance/upgrade", romeCloud.origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${romeCloud.token}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        cache: "no-store",
        body: JSON.stringify({ target }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return c.json({ error: "pantheon_unreachable" }, 502);
    }

    const mirrored = await mirrorRomeCloudResponse(response);
    if (!mirrored) return c.json({ error: "pantheon_unreachable" }, 502);
    return c.json(mirrored.body, mirrored.status);
  });

  return app;
}
