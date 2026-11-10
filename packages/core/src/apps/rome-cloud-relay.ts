import type { AppCatalog } from "./catalog.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { RelayDrainer } from "../relay/drainer.js";
import {
  RELAY_SETTING_KEY,
  deriveDepositUrl,
  resolveRelayDrains,
  sanitizeDrainUrl,
  type RelayDrainSetting,
} from "../relay/settings.js";
import { cloudBearer } from "../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../instance/rome-cloud-origin.js";
import { createLogger } from "../logger.js";

const log = createLogger("rome-cloud-relay");

// Webhook-relay mailbox provisioning via the instance token. The
// instance presents its durable bearer to Rome Cloud's `POST /api/relay/mailboxes`
// (gated on `verifyInstance`), which get-or-creates the mailbox keyed to this
// instance and returns full credentials. There is no browser handoff: the
// instance already proves its own identity, so provisioning is one authenticated
// server-to-server call it can make for itself on every boot.

/** The minimal surface this module drives, so callers (and tests) can inject doubles. */
export interface EnsureRelayMailboxDeps {
  settingsRepo: SettingsRepository;
  appCatalog: Pick<AppCatalog, "listResolved">;
  relayDrainer: Pick<RelayDrainer, "reload">;
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

export type EnsureRelayMailboxResult =
  | { status: "provisioned"; mailboxId: string }
  | { status: "not_enrolled" }
  | { status: "unconfigured" }
  | { status: "rejected"; reason: "unknown" | "revoked" }
  | { status: "unreachable" }
  | { status: "error"; message: string };

interface MintResponse {
  mailboxId?: unknown;
  connectUrl?: unknown;
  drainKey?: unknown;
  depositUrl?: unknown;
}

/**
 * Provision (get-or-create) this instance's relay mailbox and point the live
 * drainer at it. Self-healing: the call is idempotent (stable mailboxId, a fresh
 * full-TTL drainKey each time), so running it on every boot keeps the drain key
 * from aging out. Never throws — boot must not depend on Rome Cloud being
 * reachable; the result is returned for the caller to log.
 *
 * When the instance is enrolled (holds a token) this is authoritative and
 * overwrites the stored relay setting with the just-minted credentials. When it
 * is not enrolled, any manually-pasted relay setting is left untouched.
 */
export async function ensureRelayMailbox(
  deps: EnsureRelayMailboxDeps,
): Promise<EnsureRelayMailboxResult> {
  const token = await cloudBearer();
  if (!token) return { status: "not_enrolled" };

  const origin = getRomeCloudOrigin();
  if (!origin) return { status: "unconfigured" };

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/relay/mailboxes", origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
      cache: "no-store",
      // A stalled TCP connection must not hang boot provisioning forever; a
      // timeout aborts the fetch, which surfaces here as `unreachable` and
      // self-heals on the next boot. Generous because the relay-mint endpoint
      // itself takes ~6s and boot event-loop contention can push the total past
      // a tighter bound, leaving inbound relay unprovisioned until the next boot.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { status: "unreachable" };
  }

  if (response.status === 401) return { status: "rejected", reason: "unknown" };
  if (response.status === 403) return { status: "rejected", reason: "revoked" };
  if (response.status === 409) {
    return { status: "error", message: "Rome Cloud rejected relay mailbox provisioning." };
  }
  if (!response.ok) return { status: "unreachable" };

  const data = (await response.json().catch(() => null)) as MintResponse | null;
  const connectUrl = typeof data?.connectUrl === "string" ? data.connectUrl : "";
  const drainKey = typeof data?.drainKey === "string" ? data.drainKey : "";
  const mailboxId = typeof data?.mailboxId === "string" ? data.mailboxId : "";
  // mailboxId is required: it is what we report back and what an operator keys
  // off. A 200 missing any of the three is a malformed payload — fail closed
  // rather than persist a credential with a blank id.
  if (!connectUrl || !drainKey || !mailboxId) {
    return { status: "error", message: "Rome Cloud returned an invalid relay mailbox payload." };
  }

  // Derive + persist can throw (URL parsing, DB write); keep the documented
  // "never throws" contract by mapping any failure to an `error` result.
  try {
    // Rome Cloud may omit the deposit URL; derive the public /h/ face locally (same
    // mapping as the manual-paste path) so the stored setting is never missing it.
    const storedDeposit =
      typeof data?.depositUrl === "string" && data.depositUrl.length > 0
        ? data.depositUrl
        : deriveDepositUrl(connectUrl);

    const setting: RelayDrainSetting = {
      drainUrl: sanitizeDrainUrl(connectUrl),
      drainKey,
      depositUrl: storedDeposit,
    };
    await deps.settingsRepo.set(RELAY_SETTING_KEY, setting);
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // Re-point the live drainer at the freshly-minted credential without a restart.
  // reload() stops any existing connection first, so this both starts a brand-new
  // drain and re-arms an existing one with the new key.
  try {
    await deps.relayDrainer.reload(await resolveRelayDrains(deps.settingsRepo, deps.appCatalog));
  } catch (err) {
    // The setting is persisted; a later catalog change or restart picks it up.
    log.warn("relay mailbox provisioned but drainer reload failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { status: "provisioned", mailboxId };
}

// Best-effort relay provisioning at boot. Fire-and-forget: never blocks or fails
// boot, logs the outcome for operators, and self-heals on the next boot.
export async function provisionRelayMailboxAtBoot(deps: EnsureRelayMailboxDeps): Promise<void> {
  let result: EnsureRelayMailboxResult;
  try {
    result = await ensureRelayMailbox(deps);
  } catch (err) {
    log.warn("relay mailbox provisioning threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  switch (result.status) {
    case "provisioned":
      log.info("relay mailbox provisioned", { mailboxId: result.mailboxId });
      break;
    case "not_enrolled":
      log.info("relay mailbox not provisioned (instance not enrolled)");
      break;
    case "unconfigured":
      log.debug("relay mailbox not provisioned (Rome Cloud origin not configured)");
      break;
    case "unreachable":
      log.warn("could not reach Rome Cloud to provision relay mailbox");
      break;
    case "rejected":
      log.warn("relay mailbox provisioning rejected by Rome Cloud", { reason: result.reason });
      break;
    case "error":
      log.warn("relay mailbox provisioning failed", { error: result.message });
      break;
  }
}
