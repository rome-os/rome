// `/api/device-connections`: where a device reports what it lets Agents reach
// live, and where the web and the phone read it. Contract:
// docs/domains/connections.md#device-connection.

import { type Context, Hono } from "hono";
import { mayEnter } from "../../access/entry.js";
import {
  resolveSessionActorFromMaterial,
  type SessionActor,
  sessionActorMaterial,
} from "../../access/session-actor.js";
import { bySignedInSession, type DashboardAllowList } from "../../access/team.js";
import type { DrizzleDb } from "../../db/index.js";
import { readCappedBody } from "../../lib/read-capped-body.js";
import { createLogger } from "../../logger.js";
import { deviceReportSchema, MAX_REPORT_BYTES } from "../../connections/device/report.js";
import type { DeviceConnectionsRepository } from "../../connections/device/repository.js";

const log = createLogger("device-connections");

export interface DeviceConnectionRoutesDeps {
  db: DrizzleDb;
  deviceConnections: DeviceConnectionsRepository;
  now?: () => number;
  dashboardAccessState: DashboardAllowList;
  /** Who the request is. Default: the session actor resolved from the request's cookies. */
  sessionActor?: (c: Context) => Promise<SessionActor>;
}

export function deviceConnectionRoutes(deps: DeviceConnectionRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const sessionActor =
    deps.sessionActor ??
    ((c: Context) => resolveSessionActorFromMaterial(sessionActorMaterial(c), deps.db));

  // As for personal data: a team member's own signed-in session reads the
  // list, and only the guardian's reports a device, because agents reach every
  // listed device as the guardian's. A loopback caller, which an agent's shell
  // is, does not count here.
  app.use("/device-connections", async (c, next) => {
    const actor = await mayEnter(await sessionActor(c), deps.dashboardAccessState);
    if (!actor || !bySignedInSession(actor)) {
      return c.json({ error: "Guardian session required" }, 403);
    }
    const reads = c.req.method === "GET" || c.req.method === "HEAD";
    if (!reads && actor.kind !== "guardian") {
      return c.json({ error: "Guardian session required" }, 403);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/device-connections", (c) => c.json({ connections: deps.deviceConnections.list() }));

  app.put("/device-connections", async (c) => {
    // Only JSON, so a browser cannot send a report from another page without
    // a CORS preflight.
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    const text = await readCappedBody(c.req.raw, MAX_REPORT_BYTES);
    if (text === undefined) return c.json({ error: "too_large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "bad_report", message: "The body is not JSON." }, 400);
    }
    const parsed = deviceReportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "bad_report", message: parsed.error.issues[0]?.message }, 400);
    }
    const connections = deps.deviceConnections.report(parsed.data, now());
    log.info("device connections reported", {
      platform: parsed.data.device.platform,
      connections: connections.map((c) => `${c.capability}:${c.state}`).join(","),
    });
    return c.json({ connections });
  });

  return app;
}
