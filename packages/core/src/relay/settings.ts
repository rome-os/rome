import type { AppCatalog } from "../apps/catalog.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import type { RelayDrain, RelayDrainer, RelayFailure } from "./drainer.js";

const log = createLogger("relay-settings");

/** Read surface this module needs from the app catalog: enumerate installed apps. */
type RelayAppCatalog = Pick<AppCatalog, "listResolved">;

/** System-settings key holding the webhook relay mailbox credential. */
export const RELAY_SETTING_KEY = "relay";

/**
 * Persisted relay credential. Source of truth for the drainer at runtime — the
 * dashboard writes it (paste or Rome Cloud provisioning), and the env vars
 * (`config.relay`) only seed it on first boot.
 *
 * `drainUrl`/`drainKey` are the drain credential (what the drainer connects
 * with). `depositUrl` is the public address webhook senders POST to — the same
 * mailbox's `/h/{id}` face — which a consuming app (e.g. connector) registers
 * with its upstream so deliveries land in the mailbox. Drain health is gated on
 * the credential alone (see isCompleteRelaySetting); `depositUrl` is metadata
 * surfaced to the dashboard, not a precondition for draining.
 *
 * The *delivery target* is intentionally NOT stored here — it is resolved from
 * whichever installed app declares `api.relayWebhook` (see resolveRelayTarget),
 * so core never names a specific app and the binding stays trusted config.
 */
export interface RelayDrainSetting {
  drainUrl: string;
  drainKey: string;
  depositUrl: string;
}

export function isCompleteRelaySetting(value: unknown): value is RelayDrainSetting {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.drainUrl === "string" &&
    v.drainUrl.length > 0 &&
    typeof v.drainKey === "string" &&
    v.drainKey.length > 0
  );
}

/**
 * The public deposit URL paired with a drain URL. The relay exposes one mailbox
 * at two faces — `/c/{id}` for draining (the URL core holds) and `/h/{id}` for
 * deposits (the URL a sender POSTs to). Deposits must be HTTPS (Composio rejects
 * non-TLS webhooks), so the scheme maps `wss→https` / `ws→http`. Any drain-side
 * query (e.g. `?t=key`) is dropped — the deposit face takes no credential.
 */
export function deriveDepositUrl(drainUrl: string): string {
  const u = new URL(drainUrl);
  const scheme = u.protocol === "wss:" ? "https:" : "http:";
  // Fail loud on a path we can't map: a silent no-op replace would hand back the
  // drain path as the deposit URL, sending depositors to the wrong face.
  if (!u.pathname.startsWith("/c/")) {
    throw new Error(
      `relay drain URL must have a /c/{mailboxId} path to derive its deposit face, got "${u.pathname}"`,
    );
  }
  const path = u.pathname.replace(/^\/c\//, "/h/");
  return `${scheme}//${u.host}${path}`;
}

/** The app + path drained webhooks are delivered to. */
export interface RelayTarget {
  appId: string;
  path: string[];
}

/**
 * The relay delivery target: the installed app that declares `api.relayWebhook`.
 * `null` when no app declares it (the mailbox is configured but has no consumer).
 * v1 is single-consumer; if more than one app declares it we use the first and
 * warn, deferring multiplexing until a second real consumer exists.
 */
export function resolveRelayTarget(catalog: RelayAppCatalog): RelayTarget | null {
  const consumers = catalog
    .listResolved()
    .filter((app) => typeof app.api?.relayWebhook === "string");
  if (consumers.length === 0) return null;
  if (consumers.length > 1) {
    log.warn("multiple apps declare api.relayWebhook; delivering to the first", {
      apps: consumers.map((app) => app.appId),
    });
  }
  const app = consumers[0];
  return {
    appId: app.appId,
    // app.api is non-null here — the filter matched on app.api.relayWebhook.
    path: app.api!.relayWebhook!.split("/").filter(Boolean),
  };
}

/** Whether a running connection takes frames from the mailbox (relay/mailbox-claims.ts). */
export interface MailboxClaimed {
  readonly any: boolean;
}

/**
 * Current drains: the stored mailbox credential bound to the app-declared
 * target. With no app declaring `api.relayWebhook`, the mailbox is drained
 * alone, with no target, only while a connection claims it; otherwise `[]`.
 * Also `[]` when the credential is absent.
 */
export async function resolveRelayDrains(
  settingsRepo: SettingsRepository,
  catalog: RelayAppCatalog,
  claims?: MailboxClaimed,
): Promise<RelayDrain[]> {
  const setting = await settingsRepo.get<unknown>(RELAY_SETTING_KEY);
  if (!isCompleteRelaySetting(setting)) return [];
  const target = resolveRelayTarget(catalog);
  if (!target && claims?.any) {
    return [
      { connectUrl: setting.drainUrl, drainKey: setting.drainKey, targetAppId: "", targetPath: [] },
    ];
  }
  if (!target) {
    log.warn(
      "relay credential configured but no installed app declares api.relayWebhook — nothing to drain",
    );
    return [];
  }
  return [
    {
      connectUrl: setting.drainUrl,
      drainKey: setting.drainKey,
      targetAppId: target.appId,
      targetPath: target.path,
    },
  ];
}

/** Whether two resolved drain lists describe the same connection(s) + target(s). */
export function relayDrainsEqual(a: RelayDrain[], b: RelayDrain[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((d, i) => {
    const o = b[i];
    return (
      d.connectUrl === o.connectUrl &&
      d.drainKey === o.drainKey &&
      d.targetAppId === o.targetAppId &&
      d.targetPath.length === o.targetPath.length &&
      d.targetPath.every((seg, j) => seg === o.targetPath[j])
    );
  });
}

/**
 * Strip credential-bearing parts from a drain URL. A relay connect URL is a
 * bare `wss://relay/c/{mailboxId}` — the worker takes the drain key from the
 * Authorization header and reads nothing off the query — so any query on a
 * pasted URL is at best a stale `?t=` credential and at worst an unknown
 * secret. Fail closed: drop the entire query (the safe allowlist is empty) and
 * the `user:pass@` userinfo. The drainer connects with the same bare URL, so
 * persist and connect can never disagree. Robust to an unparseable value so a
 * redaction read can't throw.
 */
export function sanitizeDrainUrl(drainUrl: string): string {
  try {
    const u = new URL(drainUrl);
    u.search = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return drainUrl.split("?")[0];
  }
}

/** Mask credentials before the relay setting is returned by GET /api/settings. */
export function redactRelaySetting(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...v };
  if (typeof v.drainUrl === "string" && v.drainUrl.length > 0) {
    out.drainUrl = sanitizeDrainUrl(v.drainUrl);
  }
  if (typeof v.drainKey === "string" && v.drainKey.length > 0) {
    out.drainKey = "********";
  }
  return out;
}

export type RelayRuntimeState = "connected" | "notConnected" | "reconnecting" | "retrying";

/** Guardian-facing relay status for the Integrations tab. Never includes the drainKey. */
export interface RelayStatus {
  configured: boolean;
  drainUrl: string | null;
  depositUrl: string | null;
  targetApp: string | null;
  /** Queue depth reported by the most recent relay `ready` frame. */
  backlog: number | null;
  state: RelayRuntimeState;
  /** The scheduled reconnect or delivery retry, when the state is retrying. */
  nextAttemptAt: number | null;
  /** The active/most recent failure; seq is null for transport failures. */
  failure: RelayFailure | null;
}

export async function buildRelayStatus(
  settingsRepo: SettingsRepository,
  drainer: RelayDrainer | undefined,
  catalog: RelayAppCatalog,
): Promise<RelayStatus> {
  const setting = await settingsRepo.get<unknown>(RELAY_SETTING_KEY);
  const configured = isCompleteRelaySetting(setting);
  // v1 is single-mailbox, so the first connection's health is the relay's health.
  const conn = drainer?.getStatus()[0];
  const state: RelayRuntimeState =
    conn?.nextReconnectAt != null
      ? "reconnecting"
      : conn?.retry
        ? "retrying"
        : conn?.connected
          ? "connected"
          : "notConnected";
  const transportFailure: RelayFailure | null = conn?.lastTransportError
    ? { seq: null, status: null, error: conn.lastTransportError }
    : null;
  const failure =
    state === "reconnecting"
      ? (transportFailure ?? conn?.lastDeliveryFailure ?? null)
      : (conn?.lastDeliveryFailure ?? transportFailure);
  const nextAttemptAt =
    state === "retrying"
      ? (conn?.retry?.nextAttemptAt ?? null)
      : state === "reconnecting"
        ? (conn?.nextReconnectAt ?? null)
        : null;
  return {
    configured,
    drainUrl: configured ? sanitizeDrainUrl(setting.drainUrl) : null,
    // A pre-deposit-url stored credential can lack it; fall back rather than
    // fail the whole status read.
    depositUrl: configured ? (setting.depositUrl ?? null) : null,
    targetApp: configured ? (resolveRelayTarget(catalog)?.appId ?? null) : null,
    state,
    backlog: conn?.backlog ?? null,
    nextAttemptAt,
    failure,
  };
}
