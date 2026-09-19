import { Hono } from "hono";
import { getInstanceToken } from "../../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { currentSessionActor } from "../../lib/session-actor.js";
import { createLogger } from "../../logger.js";

const log = createLogger("user-activity");
const REPORT_INTERVAL_MS = 60_000;

export function userActivityRoutes(): Hono {
  const app = new Hono();
  let lastReport: { accountId: string; token: string; at: number } | undefined;

  app.post("/user-activity", async (c) => {
    if (c.req.header("x-rome-activity") !== "1") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actor = await currentSessionActor();
    if (actor?.kind !== "guardian" || actor.via !== "cookie" || !actor.accountId) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const token = getInstanceToken();
    const origin = getRomeCloudOrigin();
    if (!token || !origin) return c.body(null, 204);

    const now = Date.now();
    if (
      lastReport?.accountId === actor.accountId &&
      lastReport.token === token &&
      now - lastReport.at < REPORT_INTERVAL_MS
    ) {
      return c.body(null, 204);
    }
    // Reserve before awaiting so concurrent tabs and failed reports share the rate limit.
    lastReport = { accountId: actor.accountId, token, at: now };
    try {
      const response = await fetch(new URL("/api/instance/activity", origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: actor.accountId }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) log.warn("activity report rejected", { status: response.status });
    } catch {
      log.warn("activity report failed");
    }
    return c.body(null, 204);
  });

  return app;
}
