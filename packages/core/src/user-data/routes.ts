// `/api/user-data/*`: where the guardian's devices push user data, and where
// they read what Rome holds. Contract: docs/user-data.md#routes.

import { Hono } from "hono";
import { z } from "zod";
import { resolveGuardianSession } from "../access/guardian-session.js";
import type { DrizzleDb } from "../db/index.js";
import { createLogger } from "../logger.js";
import { ingestEnvelopeSchema, MAX_BATCH_BYTES, MAX_ITEMS_PER_BATCH } from "./domain/ingest.js";
import type { UserDataRepository } from "./repository.js";
import { sourceSpec } from "./sources/index.js";

const log = createLogger("user-data");

/** At most this many ingest requests per origin per minute. */
const INGESTS_PER_MINUTE = 60;

const stateSchema = z.object({ state: z.enum(["active", "paused", "off"]) });

export interface UserDataRoutesDeps {
  db: DrizzleDb;
  userData: UserDataRepository;
  now?: () => number;
}

export function userDataRoutes(deps: UserDataRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const recentIngests = new Map<string, number[]>();

  // Only the guardian's own signed-in session reads or writes personal data.
  // A loopback caller, which an agent's shell is, does not count here.
  app.use("/user-data/*", async (c, next) => {
    const session = await resolveGuardianSession(c, deps.db);
    if (!session || session.via !== "cookie") {
      return c.json({ error: "Guardian session required" }, 403);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/user-data/ingest", async (c) => {
    const receivedAt = now();
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BATCH_BYTES) return c.json({ error: "too_large" }, 413);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BATCH_BYTES) return c.json({ error: "too_large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "bad_envelope", message: "The body is not JSON." }, 400);
    }
    const parsed = ingestEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "bad_envelope", message: parsed.error.issues[0]?.message }, 400);
    }
    const envelope = parsed.data;
    const source = sourceSpec(envelope.source);
    if (!source) return c.json({ error: "unknown_source" }, 400);
    if (envelope.upserts.length + envelope.deletes.length > MAX_ITEMS_PER_BATCH) {
      return c.json({ error: "too_many_items", max: MAX_ITEMS_PER_BATCH }, 413);
    }
    const limited = rateLimited(
      recentIngests,
      `${source.source}:${envelope.origin.id}`,
      receivedAt,
    );
    if (limited) {
      c.header("Retry-After", String(limited));
      return c.json({ error: "rate_limited" }, 429);
    }
    const { response, repeated } = deps.userData.ingest(source, envelope, receivedAt);
    log.info("user data ingested", {
      source: source.source,
      trigger: envelope.batch.trigger,
      repeated,
      status: response.status,
      inserted: response.inserted,
      updated: response.updated,
      unchanged: response.unchanged,
      deleted: response.deleted,
      rejected: response.rejected.length,
    });
    return c.json(response);
  });

  app.get("/user-data/sources", (c) => c.json({ sources: deps.userData.catalog() }));

  app.put("/user-data/sources/:source/origins/:origin/state", async (c) => {
    const body = stateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_state" }, 400);
    const changed = deps.userData.setState(
      c.req.param("source"),
      c.req.param("origin"),
      body.data.state,
    );
    if (!changed) return c.json({ error: "unknown_origin" }, 404);
    return c.json({ state: body.data.state });
  });

  app.delete("/user-data/sources/:source/origins/:origin", (c) => {
    const result = deps.userData.deleteOrigin(c.req.param("source"), c.req.param("origin"), now());
    if (!result) return c.json({ error: "unknown_origin" }, 404);
    log.info("user data deleted", {
      source: c.req.param("source"),
      deletedPoints: result.deletedPoints,
    });
    return c.json(result);
  });

  app.get("/user-data/sources/:source/ingests", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    return c.json({ ingests: deps.userData.ingests(c.req.param("source"), limit) });
  });

  return app;
}

/** Seconds until the origin may ingest again, or 0 when it may now. */
function rateLimited(recent: Map<string, number[]>, key: string, at: number): number {
  const windowStart = at - 60_000;
  const kept = (recent.get(key) ?? []).filter((time) => time > windowStart);
  if (kept.length >= INGESTS_PER_MINUTE) {
    recent.set(key, kept);
    return Math.max(1, Math.ceil((kept[0] - windowStart) / 1000));
  }
  kept.push(at);
  recent.set(key, kept);
  return 0;
}
