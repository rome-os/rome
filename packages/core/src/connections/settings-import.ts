// Idempotently imports pre-registry settings credentials into the grant ledger.
//
// Existing channel settings rows (packages/core/src/db/repositories/settings.ts,
// key "telegram" etc.) predate the registry and other code still reads them
// (channels HTTP API, ChannelManager for the channels not yet migrated). This
// module is the bridge: at boot, and on every "connect"/"reload" API call, it
// copies a settings row's material into the matching connection's grant via
// `registry.importCredential` so existing users' credentials
// keep working across the upgrade WITHOUT re-connecting.
//
// Table-driven (service → settings key → grant + material extraction) so
// later phases (Discord, WhatsApp, …) add rows here, not new import functions.
//
// Idempotency is entirely `registry.importCredential`'s job (phase 1): identical
// inline material over an already-authorized grant is a no-op — no epoch
// rebuild, no `onUnlocked` re-fire. This module never validates the material
// (no network ping) — boot must not depend on the service being reachable; a
// bad credential surfaces as `CredentialRejected` at first use and follows the
// normal renew-once → degrade path.
//
// Missing/incomplete settings are a no-op, NEVER a revoke: if the ledger
// already holds an authorized grant (rehydrated by `registry.load()`) and the
// settings row was since deleted, the ledger wins — the capability stays
// unlocked. This module only ever adds/updates credentials, never removes them.

import { telegramUserSettingsKey } from "../channels/telegram-user.js";
import { WECHAT_SETTINGS_KEY } from "../channels/wechat.js";
import { discordProfileFromSettings } from "./integrations/discord.js";
import { emailProfileFromSettings } from "./integrations/email.js";
import { feishuProfileFromSettings } from "./integrations/feishu.js";
import { telegramProfileFromSettings } from "./integrations/telegram.js";
import {
  telegramUserMaterialFromSettings,
  telegramUserProfileFromSettings,
} from "./integrations/telegram-user.js";
import { wechatAccountMaterial, wechatProfileFromSettings } from "./integrations/wechat.js";
import { importWhatsAppSessionFromDirectory } from "./integrations/whatsapp.js";
import { isExplicitlyRevoked } from "./ledger.js";
import type { ConnectionRegistry } from "./registry.js";
import type { GrantName, ProfileRecord, SecretRecord } from "./types.js";

/** The read surface settings-import needs. `SettingsRepository` (the real
 *  DB-backed implementation) satisfies this structurally — declared narrowly
 *  here so tests can supply a plain in-memory fake without touching the DB. */
export interface SettingsSource {
  get<T = unknown>(key: string): Promise<T | null>;
}

/** One row of the service → settings-key → grant table. */
export interface ChannelSettingsImportRow<TSettings = Record<string, unknown>> {
  /** The settings-table key this row reads (pre-registry shape, unchanged). */
  readonly settingsKey: string;
  /** The `ConnectionDescriptor.service` this row imports into. */
  readonly service: string;
  /** The grant name on that service's descriptor. */
  readonly grant: GrantName;
  /** Pull the grant's material out of the settings row. Return `null`/`undefined`
   *  when the row is present but incomplete (e.g. no token yet) — treated the
   *  same as an absent row: a no-op import. */
  extractMaterial(settings: TSettings): SecretRecord | null | undefined;
  /** Pull the grant's profile (non-secret identity) out of the
   *  settings row, PARSED through the service's own schema (declared next to its
   *  material type). Return `null` when the row carries no identity to record — a
   *  sparse-but-valid profile still returns a value. A present-but-wrong-typed
   *  value throws (fail-closed). Services with no channel identity (WhatsApp)
   *  return `null` unconditionally. */
  extractProfile(settings: TSettings): ProfileRecord | null;
}

interface TelegramChannelSettings {
  botToken?: string;
  botUsername?: string;
  botId?: string | number;
}

/** Telegram's row. Exported so the API shims
 *  (packages/core/src/api/routes/channels.ts) can call `importOneChannel` with
 *  the exact same row the boot importer uses, instead of duplicating the
 *  service/grant/extraction mapping. */
export const TELEGRAM_SETTINGS_IMPORT_ROW: ChannelSettingsImportRow<TelegramChannelSettings> = {
  settingsKey: "telegram",
  service: "telegram",
  grant: "bot",
  extractMaterial: (settings) => (settings.botToken ? { token: settings.botToken } : null),
  extractProfile: (settings) => telegramProfileFromSettings(settings),
};

interface DiscordChannelSettings {
  botToken?: string;
  botUsername?: string;
  botId?: string;
}

/** Discord's row — grant `bot`, material `{ token }`. */
export const DISCORD_SETTINGS_IMPORT_ROW: ChannelSettingsImportRow<DiscordChannelSettings> = {
  settingsKey: "discord",
  service: "discord",
  grant: "bot",
  extractMaterial: (settings) => (settings.botToken ? { token: settings.botToken } : null),
  extractProfile: (settings) => discordProfileFromSettings(settings),
};

interface WechatChannelSettings {
  token?: string;
  baseUrl?: string;
  accountId?: string;
  userId?: string | null;
  statePath?: string;
}

/** WeChat's row — grant `account`, material `{ token, baseUrl, accountId,
 *  userId, statePath }`. Fresh pairings confer directly into the ledger; this row
 *  is the boot bridge for a pre-existing (now inert) `wechat` settings row. */
export const WECHAT_SETTINGS_IMPORT_ROW: ChannelSettingsImportRow<WechatChannelSettings> = {
  settingsKey: WECHAT_SETTINGS_KEY,
  service: "wechat",
  grant: "account",
  extractMaterial: (settings) => wechatAccountMaterial(settings),
  extractProfile: (settings) => wechatProfileFromSettings(settings),
};

interface FeishuChannelSettings {
  appId?: string;
  appSecret?: string;
  domain?: "feishu" | "lark";
  appType?: string;
}

/** Feishu's row — grant `app`, material `{ appId, appSecret, domain, appType }`.
 *  Imported once both custom-app credentials are present. */
export const FEISHU_SETTINGS_IMPORT_ROW: ChannelSettingsImportRow<FeishuChannelSettings> = {
  settingsKey: "feishu",
  service: "feishu",
  grant: "app",
  extractMaterial: (settings) => {
    if (!settings.appId || !settings.appSecret) return null;
    const material: SecretRecord = {
      appId: settings.appId,
      appSecret: settings.appSecret,
      domain: settings.domain ?? "feishu",
    };
    if (settings.appType) material.appType = settings.appType;
    return material;
  },
  extractProfile: (settings) => feishuProfileFromSettings(settings),
};

/** The LEGACY (pre-4c) email settings row shape, read as untrusted persisted
 *  JSON. Only the boot bridge consumes it: pre-direct-conferral connects wrote
 *  `address` + `inboundSecret` here, and a bridge-era install must keep
 *  hydrating its `inbox` grant at boot until the post-soak credential strip.
 *  FRESH rows are pure config (`{ enabled, guardianEmail }`) — no address, no
 *  secret — so this extractor yields nothing for them. */
interface LegacyEmailChannelSettings {
  enabled?: boolean;
  address?: string;
  inboundSecret?: string;
  guardianEmail?: string;
}

/** Email's row — grant `inbox`, material `{ address, inboundSecret }` (the new
 *  material shape: `guardianEmail` is durable config sourced by the adapter from
 *  the settings row, never material). BOOT-BRIDGE-ONLY: the connect route is the
 *  sole provisioner and confers the grant directly, so no route shim keys this
 *  row anymore — it exists to hydrate legacy credential-bearing rows through the
 *  three-way guard. Deleting it belongs to the post-soak cleanup, not the
 *  route cutover. */
export const EMAIL_SETTINGS_IMPORT_ROW: ChannelSettingsImportRow<LegacyEmailChannelSettings> = {
  settingsKey: "email",
  service: "email",
  grant: "inbox",
  extractMaterial: (settings) => {
    if (!settings.address || !settings.inboundSecret) return null;
    return { address: settings.address, inboundSecret: settings.inboundSecret };
  },
  extractProfile: (settings) => emailProfileFromSettings(settings),
};

interface TelegramUserChannelSettings {
  apiId?: number;
  apiHash?: string;
  sessionString?: string;
  phoneNumber?: string;
  userId?: string;
  username?: string | null;
  displayName?: string;
  connectedAt?: string;
}

/** Telegram user-account's row — grant `session`, material serialized from the
 *  full session settings via `telegramUserMaterialFromSettings`. Imported only
 *  once a session string exists (the login flow's completeLogin writes it). */
export const TELEGRAM_USER_SETTINGS_IMPORT_ROW: ChannelSettingsImportRow<TelegramUserChannelSettings> =
  {
    settingsKey: telegramUserSettingsKey(),
    service: "telegram_user",
    grant: "session",
    extractMaterial: (settings) => {
      if (!settings.sessionString || settings.apiId == null) return null;
      return telegramUserMaterialFromSettings({
        apiId: settings.apiId,
        apiHash: settings.apiHash ?? "",
        sessionString: settings.sessionString,
        phoneNumber: settings.phoneNumber ?? "",
        userId: settings.userId ?? "",
        username: settings.username ?? null,
        displayName: settings.displayName ?? "",
        connectedAt: settings.connectedAt ?? "",
      });
    },
    extractProfile: (settings) => telegramUserProfileFromSettings(settings),
  };

interface WhatsAppChannelSettings {
  authStatePath?: string;
}

/** WhatsApp's row — grant `session`. WhatsApp is NOT a simple `extractMaterial`:
 *  the legacy settings row stores a filesystem PATH to a `useMultiFileAuthState`
 *  directory, and the material is the serialized Baileys auth state read out of
 *  that directory ONCE. `importWhatsAppSessionFromDirectory`
 *  handles the ledger-wins + read-once + never-delete semantics; see
 *  `importOneChannel`. Kept as a row so it participates in the same
 *  boot/reload sweep as the others; `extractMaterial` is never used for it. */
export const WHATSAPP_SETTINGS_IMPORT_ROW: ChannelSettingsImportRow<WhatsAppChannelSettings> = {
  settingsKey: "whatsapp",
  service: "whatsapp",
  grant: "session",
  // Never called — the whatsapp branch of importOneChannel reads the directory
  // instead. Present only to satisfy the row shape.
  extractMaterial: () => null,
  // WhatsApp carries no channel identity in settings; its session material is
  // read from the legacy auth-state directory.
  extractProfile: () => null,
};

/** The full service → settings-key → grant table. Phase 5 appends Act rows. */
export const CHANNEL_SETTINGS_IMPORT_TABLE: readonly ChannelSettingsImportRow[] = [
  TELEGRAM_SETTINGS_IMPORT_ROW,
  DISCORD_SETTINGS_IMPORT_ROW,
  WECHAT_SETTINGS_IMPORT_ROW,
  FEISHU_SETTINGS_IMPORT_ROW,
  EMAIL_SETTINGS_IMPORT_ROW,
  TELEGRAM_USER_SETTINGS_IMPORT_ROW,
  WHATSAPP_SETTINGS_IMPORT_ROW,
];

/** Services whose Talk capability needs no grant (zero-grant unlock at
 *  birth): a connection must simply EXIST for the bridge to register
 *  its adapter. `ensureZeroGrantConnections` mints one per service at boot if
 *  absent. WebChat is the only one this phase. */
export const ZERO_GRANT_SERVICES: readonly string[] = ["webchat"];

/**
 * Import a single row: read its settings key, and if it carries usable
 * material, make sure a connection exists for the row's service and import the
 * credential into the row's grant.
 *
 * `registry.find(service)[0] ?? registry.connect(service)` mints the connection
 * on first import (fresh install / first boot after upgrade); subsequent calls
 * (reboot, reload, re-saving the same settings) reuse the existing connection —
 * `importCredential`'s material comparison makes the whole call a no-op when
 * nothing changed.
 *
 * This is the FULL-import path (credential + profile), driven by the
 * connect/reload route shims: a guardian-driven re-save with a rotated token
 * must reach the credential (`importCredential` rebuilds the grant epoch when the
 * material changed). The BOOT sweep uses {@link reconcileOneChannel} instead — a
 * three-way guard that never lets a frozen settings row resurrect a rotated
 * ledger credential.
 */
export async function importOneChannel(
  registry: ConnectionRegistry,
  settingsRepo: SettingsSource,
  row: ChannelSettingsImportRow,
): Promise<void> {
  const settings = await settingsRepo.get<Record<string, unknown>>(row.settingsKey);
  if (!settings) return;

  // WhatsApp is the one non-`extractMaterial` service: the legacy row stores a
  // directory path, and the material is the serialized Baileys auth state read
  // out of it ONCE (ledger wins, directory never deleted). Mint
  // the connection first so the migration helper can consult its grant state.
  if (row.service === "whatsapp") {
    const authStatePath = (settings as WhatsAppChannelSettings).authStatePath;
    if (!authStatePath) return;
    const existing = registry.find(row.service)[0];
    const conn = existing ?? (await registry.connect(row.service));
    await importWhatsAppSessionFromDirectory({
      connection: conn,
      authStatePath,
      importCredential: (grant, cred) => registry.importCredential(conn.id, grant, cred),
    });
    return;
  }

  const material = row.extractMaterial(settings);
  if (!material) return;
  // Extract the identity in the SAME pass as the material so a fresh connect
  // records both in one importCredential update. A parse rejection
  // throws here, before anything is persisted (fail-closed).
  const profile = row.extractProfile(settings) ?? undefined;
  const existing = registry.find(row.service)[0];
  const conn = existing ?? (await registry.connect(row.service));
  await registry.importCredential(conn.id, row.grant, { material, expiresAt: "never" }, profile);
}

/**
 * Boot-time reconcile of a single row: the three-way guard, mirroring the
 * provider reconciler (`reconcileProviderAccounts`), plus the
 * explicit-revoke tombstone.
 *
 *   - Grant explicitly revoked (`isExplicitlyRevoked`: unauthorized with a prior
 *     conferral on record) → no-op. The guardian disconnected; the retained
 *     legacy settings row must NOT resurrect the credential at the next boot.
 *     Reconnecting is the connect ceremony's job (a route-driven conferral that
 *     stamps a fresh `conferredAt`), never this sweep's.
 *   - Grant absent or never-conferred `unauthorized` → full import: credential +
 *     profile (a bridge-era install hydrating on its first post-registry boot).
 *   - Grant `authorized`/`degraded` WITHOUT a profile → profile-only backfill;
 *     the credential is untouched and no grant epoch is rebuilt (a bridge-era
 *     install connected before profiles existed gets its identity without a
 *     credential write).
 *   - Grant that already has a profile → untouched.
 *
 * Thus a frozen legacy settings row can hydrate a bridge-era install but can
 * NEVER resurrect over a rotated ledger credential OR a guardian's disconnect —
 * the ledger is authoritative from its first write. Runs after
 * `registry.load()`, so an authorized grant is already rehydrated when this
 * reads it.
 */
export async function reconcileOneChannel(
  registry: ConnectionRegistry,
  settingsRepo: SettingsSource,
  row: ChannelSettingsImportRow,
): Promise<void> {
  const settings = await settingsRepo.get<Record<string, unknown>>(row.settingsKey);
  if (!settings) return;

  // The revoke tombstone applies to EVERY row — including WhatsApp, whose
  // directory helper below only distinguishes "unauthorized", not "revoked".
  const existing = registry.find(row.service)[0];
  const grantRec = existing ? await registry.getLedger().getGrant(existing.id, row.grant) : null;
  if (isExplicitlyRevoked(grantRec)) return;

  // WhatsApp's directory helper carries the same ledger-wins guard internally
  // (it imports only when the session grant is `unauthorized`), and WhatsApp has
  // no channel profile — so its full-import path IS its three-way behavior.
  if (row.service === "whatsapp") {
    await importOneChannel(registry, settingsRepo, row);
    return;
  }

  const material = row.extractMaterial(settings);
  if (!material) return;
  const profile = row.extractProfile(settings);

  if (!existing) {
    // No ledger connection yet (fresh install): mint it and full-import. The
    // grant starts `unauthorized`, so this is the first branch of the guard.
    const conn = await registry.connect(row.service);
    await registry.importCredential(
      conn.id,
      row.grant,
      { material, expiresAt: "never" },
      profile ?? undefined,
    );
    return;
  }

  const state = grantRec?.state ?? "unauthorized";
  if (state === "unauthorized") {
    await registry.importCredential(
      existing.id,
      row.grant,
      { material, expiresAt: "never" },
      profile ?? undefined,
    );
    return;
  }

  // Authorized or degraded: the ledger credential wins — never replace it, never
  // resurrect a degraded one. Backfill only a MISSING profile; a non-null profile
  // is a newer conferral and is never clobbered.
  if (grantRec?.profile == null && profile != null) {
    await registry.backfillProfile(existing.id, row.grant, profile);
  }
}

/**
 * Make sure a connection exists for every zero-grant service. These
 * unlock at birth (no credential to import), so all boot needs to do is mint the
 * connection once — the registry builds the Talk epoch immediately and the
 * bridge registers its adapter on the synchronous first unlock. Idempotent:
 * skips a service that already has a connection (rehydrated by `registry.load()`).
 */
export async function ensureZeroGrantConnections(registry: ConnectionRegistry): Promise<void> {
  for (const service of ZERO_GRANT_SERVICES) {
    // Skip services this registry does not declare (e.g. a test registering only
    // a subset of descriptors); connect() would otherwise throw "no registered
    // descriptor".
    if (!registry.isRegistered(service)) continue;
    if (registry.find(service).length === 0) {
      await registry.connect(service);
    }
  }
}

/**
 * Boot-time entry point: reconcile every row of the table into the ledger. Called
 * after `registry.register()` + `registry.load()` (so ledger-hydrated connections
 * exist before this reconciles them against settings), before any bridge consumer
 * needs a connection. Each row runs through {@link reconcileOneChannel}'s
 * three-way guard, so a frozen legacy credential never resurrects over a rotated
 * ledger credential — it only ever hydrates a bridge-era install or backfills a
 * missing profile.
 */
export async function importChannelSettings(
  registry: ConnectionRegistry,
  settingsRepo: SettingsSource,
): Promise<void> {
  await ensureZeroGrantConnections(registry);
  for (const row of CHANNEL_SETTINGS_IMPORT_TABLE) {
    await reconcileOneChannel(registry, settingsRepo, row);
  }
}
