import "dotenv/config";
import { z } from "zod";
import { DEFAULT_SQLITE_PATH } from "./db/index.js";
import { resolveInstanceSlug } from "./lib/runtime.js";

/**
 * A relay drain URL must be a parseable ws/wss URL pointing at a `/c/{mailboxId}`
 * mailbox face. Validated here so a typo in RELAY_DRAIN_URL fails boot loudly
 * rather than being persisted on first boot and wedging the drainer later (env
 * seeding only runs while the setting is absent, so a bad value would stick).
 */
function isWssDrainUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "ws:" || u.protocol === "wss:") && u.pathname.startsWith("/c/");
  } catch {
    return false;
  }
}

const configSchema = z.object({
  // Instance slug — the stable per-instance identifier (the `PANTHEON_SLUG`
  // tenant slug; the local Rome Cloud `dev` tenant in dev). Absent when this
  // instance has no slug. Surfaced here so rollout gating can key on it; see
  // `resolveInstanceSlug`.
  instanceSlug: z.string().optional(),

  // Statsig server secret key. When present, the cloud-auth rollout gate
  // (`rome_cloud_auth`) is evaluated against Statsig live on each /login, keyed
  // on `instanceSlug`. Absent leaves the gate to the all-off default (fail
  // closed to local auth) plus any `FEATURE_GATE_*` env override.
  statsigServerSecretKey: z.string().optional(),

  // Sentinel
  sentinelReviewIntervalMinutes: z.coerce.number().int().positive().default(120),

  // LinkedIn inbox poll cadence. Every tick draws a fresh uniform delay in
  // [min, max] so the sync traffic never looks like a metronome to LinkedIn.
  linkedinPollMinMinutes: z.coerce.number().int().positive().default(15),
  linkedinPollMaxMinutes: z.coerce.number().int().positive().default(30),

  // System upgrade — how long the consent countdown runs before proceeding on
  // silence. Fits inside the reserved 3:00–3:30am nightly window.
  systemUpgradeCountdownMinutes: z.coerce.number().int().positive().default(10),

  hostExecutionSocket: z.string().startsWith("/").optional(),
  hostExecutionEnabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Every root, delegated, and warm action worker counts against this bound.
  // A bounded default keeps burst traffic from forking unbounded workers;
  // operators can tune it to measured worker RSS.
  actionWorkerMaxProcesses: z.coerce.number().int().positive().default(8),

  // Database
  database: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("sqlite"),
      sqlitePath: z.string().default(DEFAULT_SQLITE_PATH),
      encryptionKey: z.string().optional(),
    }),
    z.object({
      type: z.literal("postgresql"),
      postgresConnectionString: z.string(),
    }),
  ]),

  // Web server
  webServer: z
    .object({
      port: z.coerce.number().int().positive().default(3000),
      host: z.string().default("localhost"),
    })
    .default(() => ({ port: 3000, host: "localhost" })),

  // Internal API (backend ↔ web dashboard communication).
  // Bind to the IPv4 loopback literal rather than "localhost" — on Linux
  // Node's listen() may bind only the IPv6 form of "localhost" (::1) while
  // in-container clients (Vite proxy, fetch-based MCP callers) connect via
  // 127.0.0.1, producing ECONNREFUSED.
  internalApi: z
    .object({
      port: z.coerce.number().int().positive().default(4141),
      host: z.string().default("127.0.0.1"),
      webhookApiKey: z.string().optional(),
      webRoot: z.string().optional(),
    })
    .default(() => ({ port: 4141, host: "127.0.0.1" })),

  // Anthropic
  anthropicApiKey: z.string().optional(),

  // Observability
  otelExporterEndpoint: z.string().optional(),

  // Webhook relay drainer. Absent unless explicitly configured. When present, a
  // persistent WS client drains buffered webhooks from the Cloudflare relay and
  // replays them into the target app handler. Core stays app-neutral: this holds
  // only the mailbox credential — the delivery target is resolved at runtime
  // from whichever installed app declares `api.relayWebhook` (see
  // resolveRelayTarget in relay/settings.ts), never named here.
  relay: z
    .object({
      drainUrl: z
        .string()
        .refine(isWssDrainUrl, "must be a ws:// or wss:// URL with a /c/{mailboxId} path"),
      drainKey: z.string().min(1),
    })
    .optional(),
});

const validatedConfigSchema = configSchema.refine(
  (cfg) => cfg.linkedinPollMinMinutes <= cfg.linkedinPollMaxMinutes,
  { message: "LINKEDIN_POLL_MIN_MINUTES must not exceed LINKEDIN_POLL_MAX_MINUTES" },
);

export type Config = z.infer<typeof configSchema>;

function envToRawConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  // Statsig server secret key (gates the cloud-auth rollout). Absent disables
  // the gate entirely.
  if (env.STATSIG_SERVER_SECRET_KEY) {
    raw.statsigServerSecretKey = env.STATSIG_SERVER_SECRET_KEY;
  }

  // Instance slug, normalized from PANTHEON_SLUG. Left absent (not "") when
  // unset/blank so the schema's optional stays undefined rather than a bucket.
  const instanceSlug = resolveInstanceSlug(env);
  if (instanceSlug !== undefined) {
    raw.instanceSlug = instanceSlug;
  }

  // Scalars
  if (env.SENTINEL_REVIEW_INTERVAL_MINUTES) {
    raw.sentinelReviewIntervalMinutes = env.SENTINEL_REVIEW_INTERVAL_MINUTES;
  }
  if (env.SYSTEM_UPGRADE_COUNTDOWN_MINUTES) {
    raw.systemUpgradeCountdownMinutes = env.SYSTEM_UPGRADE_COUNTDOWN_MINUTES;
  }
  if (env.ROME_HOST_EXECUTION_SOCKET) {
    raw.hostExecutionSocket = env.ROME_HOST_EXECUTION_SOCKET;
  }
  if (env.ROME_HOST_EXECUTION_ENABLED !== undefined) {
    raw.hostExecutionEnabled = env.ROME_HOST_EXECUTION_ENABLED;
  }
  if (env.LINKEDIN_POLL_MIN_MINUTES) {
    raw.linkedinPollMinMinutes = env.LINKEDIN_POLL_MIN_MINUTES;
  }
  if (env.LINKEDIN_POLL_MAX_MINUTES) {
    raw.linkedinPollMaxMinutes = env.LINKEDIN_POLL_MAX_MINUTES;
  }
  if (env.ROME_ACTION_MAX_WORKERS) {
    raw.actionWorkerMaxProcesses = env.ROME_ACTION_MAX_WORKERS;
  }
  // Database
  const dbType = env.DATABASE_TYPE ?? "sqlite";
  if (dbType === "postgresql") {
    if (!env.POSTGRES_CONNECTION_STRING) {
      throw new Error("POSTGRES_CONNECTION_STRING is required when DATABASE_TYPE=postgresql");
    }
    raw.database = {
      type: "postgresql",
      postgresConnectionString: env.POSTGRES_CONNECTION_STRING,
    };
  } else {
    raw.database = {
      type: "sqlite",
      ...(env.SQLITE_PATH && { sqlitePath: env.SQLITE_PATH }),
      ...(env.SQLITE_ENCRYPTION_KEY && { encryptionKey: env.SQLITE_ENCRYPTION_KEY }),
    };
  }

  // Web server (always provide object so inner defaults are applied)
  const webServer: Record<string, unknown> = {};
  if (env.WEB_PORT) webServer.port = env.WEB_PORT;
  if (env.WEB_HOST) webServer.host = env.WEB_HOST;
  raw.webServer = webServer;

  // Internal API
  const internalApi: Record<string, unknown> = {};
  if (env.INTERNAL_API_PORT) internalApi.port = env.INTERNAL_API_PORT;
  if (env.INTERNAL_API_WEBHOOK_API_KEY) {
    internalApi.webhookApiKey = env.INTERNAL_API_WEBHOOK_API_KEY;
  }
  if (env.INTERNAL_API_WEB_ROOT) internalApi.webRoot = env.INTERNAL_API_WEB_ROOT;
  raw.internalApi = internalApi;

  // Anthropic (optional — falls back to Claude subscription when unset)
  if (env.ANTHROPIC_API_KEY) {
    raw.anthropicApiKey = env.ANTHROPIC_API_KEY;
  }

  // Observability
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    raw.otelExporterEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }

  // Webhook relay drainer. Build the object only when a RELAY_DRAIN_* var is
  // set, then let the schema enforce that BOTH fields are present — a partial
  // credential fails loud rather than half-configuring. The delivery target is
  // not config: it comes from whichever installed app declares
  // `api.relayWebhook`, so a depositor can never pick it via the relay frame.
  if (env.RELAY_DRAIN_URL || env.RELAY_DRAIN_KEY) {
    raw.relay = {
      drainUrl: env.RELAY_DRAIN_URL,
      drainKey: env.RELAY_DRAIN_KEY,
    };
  }

  return raw;
}

export function loadConfig(): Config {
  const raw = envToRawConfig(process.env);
  const result = validatedConfigSchema.safeParse(raw);

  if (!result.success) {
    const formatted = z.prettifyError(result.error);
    throw new Error(`Invalid configuration:\n${formatted}`);
  }

  return result.data;
}
