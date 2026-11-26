// `/api/device-connections`: where a device reports what it lets Agents reach
// live, and where the web and the phone read it. Contract:
// docs/domains/connections.md#device-connection.

import { Hono } from "hono";
import { enteredPerson } from "../../access/require-entry.js";
import { bySignedInSession } from "../../access/team.js";
import { readCappedBody } from "../../lib/read-capped-body.js";
import { createLogger } from "../../logger.js";
import { deviceReportSchema, MAX_REPORT_BYTES } from "../../connections/device/report.js";
import type { DeviceConnectionsRepository } from "../../connections/device/repository.js";

const log = createLogger("device-connections");

export interface DeviceConnectionRoutesDeps {
  deviceConnections: DeviceConnectionsRepository;
  now?: () => number;
}

export function deviceConnectionRoutes(deps: DeviceConnectionRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  // As for personal data: only the guardian reports a device, because agents
  // reach every listed device as the guardian's. A loopback caller, which an
  // agent's shell is, neither reads the list nor reports here.
  app.use("/device-connections", async (c, next) => {
    const actor = enteredPerson(c);
    if (!bySignedInSession(actor)) {
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
