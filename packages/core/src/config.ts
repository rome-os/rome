import "dotenv/config";
import { z } from "zod";
import { JWT_SECRET } from "./access/auth.js";
import { DEFAULT_SQLITE_PATH } from "./db/index.js";

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
  // Statsig server secret key. When present, the cloud-auth rollout gate
  // (`rome_cloud_auth`) is evaluated against Statsig live on each /login, keyed
  // on the instance slug. Absent leaves the gate to the all-off default (fail
  // closed to local auth) plus any `FEATURE_GATE_*` env override.
  statsigServerSecretKey: z.string().optional(),

  // LinkedIn inbox poll cadence. Every tick draws a fresh uniform delay in
  // [min, max] so the sync traffic never looks like a metronome to LinkedIn.
  linkedinPollMinMinutes: z.coerce.number().int().positive().default(15),
  linkedinPollMaxMinutes: z.coerce.number().int().positive().default(30),

  // How long a renewed session's predecessor has to write its handoff before
  // a small model writes it from the chat's messages instead
  // (docs/concepts/sessions.md#handoff).
  sessionHandoffTimeoutSeconds: z.coerce.number().int().positive().default(30),
  // How long the small model then has to write it.
  sessionHandoffFallbackTimeoutSeconds: z.coerce.number().int().positive().default(30),
  // Past this many tokens of context, a Concierge session is renewed with a
  // handoff once its turn ends and nothing waits on it.
  // At least 50K: a new session starts near 30K, and a limit near that would
  // renew it after every turn.
  sessionHandoffContextTokens: z.coerce.number().int().min(50_000).default(150_000),
  // Past this many tokens, a message that comes while that renewal's handoff
  // is written waits for the renewal; under it, the retired session answers.
  // Read as at least the limit above.
  sessionHandoffHardContextTokens: z.coerce.number().int().min(50_000).default(180_000),

  // System upgrade — how long the consent countdown runs before proceeding on
  // silence. Fits inside the reserved 3:00–3:30am nightly window.
  systemUpgradeCountdownMinutes: z.coerce.number().int().positive().default(10),
  // Where runtime releases keep their release-notes.json, read as
  // `<url>/v<version>/release-notes.json`. The upgrade dialog shows them.
  releaseNotesUrl: z
    .string()
    .regex(/^https?:\/\//, "must be an http:// or https:// URL")
    .default("https://github.com/rome-os/rome/releases/download"),

  // How long a question card or an approval in a Concierge task chat keeps
  // the task waiting for its owner. After it the task ends for no response
  // and an approval is turned down. A day by default; shorter for live tests.
  conciergeTaskWaitExpiryMinutes: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60),

  // Hours between two runs of the Concierge patrol. Quiet hours, digest times
  // and a guardian who is away hold it more often than this.
  conciergePatrolIntervalHours: z.coerce.number().int().min(1).max(24).default(3),

  hostExecutionSocket: z.string().startsWith("/").optional(),
  computerUseLocalDeviceId: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
  hostExecutionEnabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  cdpAutomationEnabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Every root, delegated, and warm action worker counts against this bound.
  // Unset, the host sizes it to the instance's memory at startup (see
  // defaultWorkerCap); operators can pin it to measured worker RSS.
  actionWorkerMaxProcesses: z.coerce.number().int().positive().optional(),

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

  // The Slack gateway Worker for Rome's own Slack app connection (`slack_app`):
  // it holds the app and its tokens, and makes Slack's Web API calls for this
  // instance. A test environment points it at its own Worker.
  slackGatewayUrl: z
    .string()
    .url()
    .default("https://slack.romeos.io")
    .transform((value) => new URL(value).origin),

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

  // Scalars
  if (env.SYSTEM_UPGRADE_COUNTDOWN_MINUTES) {
    raw.systemUpgradeCountdownMinutes = env.SYSTEM_UPGRADE_COUNTDOWN_MINUTES;
  }
  if (env.ROME_RELEASE_NOTES_URL) {
    raw.releaseNotesUrl = env.ROME_RELEASE_NOTES_URL;
  }
  if (env.CONCIERGE_TASK_WAIT_EXPIRY_MINUTES) {
    raw.conciergeTaskWaitExpiryMinutes = env.CONCIERGE_TASK_WAIT_EXPIRY_MINUTES;
  }
  if (env.CONCIERGE_PATROL_INTERVAL_HOURS) {
    raw.conciergePatrolIntervalHours = env.CONCIERGE_PATROL_INTERVAL_HOURS;
  }
  if (env.ROME_HOST_EXECUTION_SOCKET) {
    raw.hostExecutionSocket = env.ROME_HOST_EXECUTION_SOCKET;
  }
  if (env.ROME_COMPUTER_USE_LOCAL_DEVICE_ID !== undefined) {
    raw.computerUseLocalDeviceId = env.ROME_COMPUTER_USE_LOCAL_DEVICE_ID;
  }
  if (env.ROME_HOST_EXECUTION_ENABLED !== undefined) {
    raw.hostExecutionEnabled = env.ROME_HOST_EXECUTION_ENABLED;
  }
  if (env.ROME_ENABLE_CDP_AUTOMATION !== undefined) {
    raw.cdpAutomationEnabled = env.ROME_ENABLE_CDP_AUTOMATION;
  }
  if (env.LINKEDIN_POLL_MIN_MINUTES) {
    raw.linkedinPollMinMinutes = env.LINKEDIN_POLL_MIN_MINUTES;
  }
  if (env.LINKEDIN_POLL_MAX_MINUTES) {
    raw.linkedinPollMaxMinutes = env.LINKEDIN_POLL_MAX_MINUTES;
  }
  if (env.SESSION_HANDOFF_TIMEOUT_SECONDS) {
    raw.sessionHandoffTimeoutSeconds = env.SESSION_HANDOFF_TIMEOUT_SECONDS;
  }
  if (env.SESSION_HANDOFF_FALLBACK_TIMEOUT_SECONDS) {
    raw.sessionHandoffFallbackTimeoutSeconds = env.SESSION_HANDOFF_FALLBACK_TIMEOUT_SECONDS;
  }
  if (env.SESSION_HANDOFF_CONTEXT_TOKENS) {
    raw.sessionHandoffContextTokens = env.SESSION_HANDOFF_CONTEXT_TOKENS;
  }
  if (env.SESSION_HANDOFF_HARD_CONTEXT_TOKENS) {
    raw.sessionHandoffHardContextTokens = env.SESSION_HANDOFF_HARD_CONTEXT_TOKENS;
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

  if (env.SLACK_GATEWAY_URL) raw.slackGatewayUrl = env.SLACK_GATEWAY_URL;

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
  const configuredSecret = process.env.ROME_JWT_SECRET;
  if (
    result.data.computerUseLocalDeviceId !== undefined &&
    (!configuredSecret ||
      configuredSecret.length < 32 ||
      JWT_SECRET !== configuredSecret ||
      JWT_SECRET === "rome-dev-secret-change-me")
  )
    throw new Error(
      "Protected device use requires an explicit ROME_JWT_SECRET of at least 32 characters.",
    );

  return result.data;
}
