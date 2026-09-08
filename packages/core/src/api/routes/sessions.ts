import { Hono, type Context } from "hono";
import { z } from "zod";
import type {
  RomeSessionDetail,
  RomeSessionsPageResult,
  SessionMetricsRequest,
  SessionMetricsResponse,
  SessionQueryRequest,
} from "@rome/api-types/sessions";
import { TURN_END_STATUSES } from "@rome/api-types/trace-segments";

export interface SessionQueries {
  querySessions(request: SessionQueryRequest): Promise<RomeSessionsPageResult>;
  queryMetrics(request: SessionMetricsRequest): Promise<SessionMetricsResponse>;
  getSession(id: string): Promise<RomeSessionDetail | null>;
}

const sessionTypeSchema = z.enum([
  "webchat",
  "webchat_handoff",
  "channel",
  "action",
  "fork",
  "subagent",
]);
const outcomeSchema = z.enum([...TURN_END_STATUSES, "unknown"]);
const metricSchema = z.enum(["runs", "tokens", "cost", "errors"]);
const dimensionSchema = z.enum(["app", "type", "source", "agent", "model", "project"]);
const intervalSchema = z.enum(["none", "hour", "day", "week", "auto"]);
const nonEmptyString = z.string().trim().min(1);

const timeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), value: z.enum(["24h", "7d", "30d"]) }).strict(),
  z
    .object({ kind: z.literal("absolute"), from: z.iso.datetime(), to: z.iso.datetime() })
    .strict()
    .refine((value) => Date.parse(value.from) < Date.parse(value.to), {
      message: "from must be before to",
      path: ["from"],
    }),
  z.object({ kind: z.literal("all") }).strict(),
]);

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("core") }).strict(),
  z.object({ kind: z.literal("app"), appId: nonEmptyString }).strict(),
  z.object({ kind: z.literal("uninstalled") }).strict(),
]);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("internal") }).strict(),
  z.object({ kind: z.literal("channel"), channel: nonEmptyString }).strict(),
]);
const modelSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("named"), provider: nonEmptyString.optional(), name: nonEmptyString })
    .strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);

const scopeSchema = z
  .object({
    time: timeSchema,
    timeZone: nonEmptyString.refine((timeZone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone }).format();
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA time zone"),
    sessions: z
      .object({
        ids: z.array(nonEmptyString).max(100).optional(),
        types: z.array(sessionTypeSchema).max(6).optional(),
        owners: z.array(ownerSchema).max(100).optional(),
        agentNames: z.array(nonEmptyString).max(100).optional(),
        sources: z.array(sourceSchema).max(100).optional(),
        projectPathPrefix: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
    runs: z
      .object({
        models: z.array(modelSchema).max(100).optional(),
        outcomes: z.array(outcomeSchema).max(4).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const querySchema = z
  .object({
    scope: scopeSchema,
    search: z.string().trim().max(500).optional(),
    sort: z
      .object({
        field: z.enum(["activity", "runs", "tokens", "cost", "errors"]),
        direction: z.enum(["asc", "desc"]).optional(),
      })
      .strict()
      .optional(),
    page: z
      .object({
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const metricsSchema = z
  .object({
    scope: scopeSchema,
    projections: z
      .array(
        z
          .object({
            id: z
              .string()
              .trim()
              .min(1)
              .max(50)
              .regex(/^[a-zA-Z0-9_-]+$/),
            groupBy: dimensionSchema,
            interval: intervalSchema,
            rankBy: metricSchema,
            limit: z.number().int().min(1).max(100).optional(),
            includeOther: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(3)
      .refine((values) => new Set(values.map((value) => value.id)).size === values.length, {
        message: "Projection ids must be unique",
      }),
  })
  .strict();

async function readBody(c: Context) {
  return c.req.json().catch(() => null);
}

export function sessionsRoutes(service: SessionQueries): Hono {
  const app = new Hono();

  app.post("/sessions/query", async (c) => {
    const parsed = querySchema.safeParse(await readBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    }
    return c.json(await service.querySessions(parsed.data));
  });

  app.post("/sessions/metrics", async (c) => {
    const parsed = metricsSchema.safeParse(await readBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    }
    return c.json(await service.queryMetrics(parsed.data));
  });

  app.get("/sessions/:id", async (c) => {
    const session = await service.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  return app;
}
