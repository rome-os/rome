// Settings-import tests.
//
// Covers:
//   fresh settings → connection created + authorized
//   re-run (identical token) → no new connection, no epoch churn
//   token change → new material + fresh epoch
//   settings row absent → no-op
//   settings row present but incomplete (no botToken) → no-op
//   ledger already populated + settings absent → ledger wins (rehydration,
//     import must NOT revoke)
//   generic row plumbing via importOneChannel (proves the table is
//     service-agnostic, not telegram-special-cased in the importer)
//   CHANNEL_SETTINGS_IMPORT_TABLE shape

import { afterEach, describe, it, expect } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import { tokenPaste } from "./schemes.js";
import { makeFakeTalkerFactory, makeFakeActorFactory } from "./test-fixtures.js";
import type { ConnectionDescriptor } from "./types.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_SETTINGS_IMPORT_TABLE,
  DISCORD_SETTINGS_IMPORT_ROW,
  EMAIL_SETTINGS_IMPORT_ROW,
  ensureZeroGrantConnections,
  FEISHU_SETTINGS_IMPORT_ROW,
  TELEGRAM_SETTINGS_IMPORT_ROW,
  TELEGRAM_USER_SETTINGS_IMPORT_ROW,
  WECHAT_SETTINGS_IMPORT_ROW,
  WHATSAPP_SETTINGS_IMPORT_ROW,
  importChannelSettings,
  importOneChannel,
  type ChannelSettingsImportRow,
  type SettingsSource,
} from "./settings-import.js";
import { makeWebchatDescriptor } from "./integrations/webchat.js";

// A fresh drizzle-backed ledger per test (InMemoryGrantLedger left with p1);
// opened DBs are closed after each test.
const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

// Test doubles

/** A minimal in-memory stand-in for SettingsRepository — settings-import only
 *  needs `get`, so the fake doesn't touch the DB. */
function makeSettingsSource(initial?: Record<string, unknown>): SettingsSource & {
  set(key: string, value: unknown): void;
  delete(key: string): void;
} {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    async get<T>(key: string): Promise<T | null> {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
    delete(key: string) {
      store.delete(key);
    },
  };
}

/** Descriptor shaped exactly like the real Telegram descriptor's auth surface
 *  (service "telegram", grant "bot") but with a fake Talker so no network is
 *  touched. Matches the hardcoded service/grant in TELEGRAM_SETTINGS_IMPORT_ROW. */
function makeTelegramLikeDescriptor() {
  const talkerFactory = makeFakeTalkerFactory();
  const descriptor: ConnectionDescriptor = {
    service: "telegram",
    auth: {
      bot: tokenPaste({
        label: "Telegram bot token",
        validate: async (_token: string) => {
          // No validation ping at import time (spec §3) — always "valid" here.
        },
      }),
    },
    capabilities: {
      talker: {
        needs: ["bot"] as const,
        build(creds) {
          return talkerFactory.build(creds);
        },
      },
    },
  };
  return { descriptor, talkerFactory };
}

// Table shape

describe("CHANNEL_SETTINGS_IMPORT_TABLE", () => {
  it("has one row per migrated Talk channel (phase 4a scope)", () => {
    // Every registry-owned channel that carries importable material has a row.
    // webchat is zero-grant (ZERO_GRANT_SERVICES, not a material row).
    const rows = CHANNEL_SETTINGS_IMPORT_TABLE.map((r) => ({
      service: r.service,
      grant: r.grant,
    }));
    // Email's row is BOOT-BRIDGE-ONLY: fresh connects confer the inbox grant
    // directly at the route, but a legacy credential-bearing row
    // must keep hydrating at boot until the post-soak bridge deletion.
    expect(rows).toEqual([
      { service: "telegram", grant: "bot" },
      { service: "discord", grant: "bot" },
      { service: "wechat", grant: "account" },
      { service: "feishu", grant: "app" },
      { service: "email", grant: "inbox" },
      { service: "telegram_user", grant: "session" },
      { service: "whatsapp", grant: "session" },
    ]);
    expect(TELEGRAM_SETTINGS_IMPORT_ROW.settingsKey).toBe("telegram");
    expect(TELEGRAM_SETTINGS_IMPORT_ROW.service).toBe("telegram");
    expect(TELEGRAM_SETTINGS_IMPORT_ROW.grant).toBe("bot");
  });
});

// importChannelSettings — telegram row

describe("importChannelSettings — telegram", () => {
  it("fresh settings → connection created + authorized + unlocked", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    const settings = makeSettingsSource({ telegram: { botToken: "tok-1" } });
    await importChannelSettings(registry, settings);

    expect(registry.all()).toHaveLength(1);
    const conn = registry.all()[0];
    expect(conn.service).toBe("telegram");
    expect(conn.auth.grants().bot).toBe("authorized");
    expect(conn.talk).not.toBeNull();
    expect(talkerFactory.instances).toHaveLength(1);
    expect(talkerFactory.instances[0].state.starts[0].creds.bot.material).toEqual({
      token: "tok-1",
    });
  });

  it("re-run with identical token → no new connection, no epoch churn", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    let unlockFireCount = 0;
    registry.onUnlocked("talk", () => {
      unlockFireCount++;
    });

    const settings = makeSettingsSource({ telegram: { botToken: "tok-1" } });
    await importChannelSettings(registry, settings);
    expect(unlockFireCount).toBe(1);
    expect(registry.all()).toHaveLength(1);
    const firstConnId = registry.all()[0].id;

    // Re-run at "reboot" — identical settings row, same registry state.
    await importChannelSettings(registry, settings);
    await importChannelSettings(registry, settings);

    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0].id).toBe(firstConnId);
    // importCredential's material comparison makes the re-import a full no-op:
    // no epoch rebuild (no second Talker build), no onUnlocked re-fire.
    expect(talkerFactory.instances).toHaveLength(1);
    expect(unlockFireCount).toBe(1);
  });

  it("boot with a changed token over an authorized grant → no credential write, no epoch rebuild (three-way guard)", async () => {
    // The boot sweep (importChannelSettings) is guarded and boot-only: the
    // ledger credential wins. A frozen settings row carrying a different token
    // must NOT resurrect over the authorized ledger credential.
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    let unlockFireCount = 0;
    registry.onUnlocked("talk", () => {
      unlockFireCount++;
    });

    const settings = makeSettingsSource({ telegram: { botToken: "tok-1" } });
    await importChannelSettings(registry, settings);
    expect(unlockFireCount).toBe(1);
    const connId = registry.all()[0].id;

    settings.set("telegram", { botToken: "tok-2" });
    await importChannelSettings(registry, settings);

    // Same connection, SAME epoch: boot never touched the authorized credential,
    // so no second Talker was built and no onUnlocked re-fired.
    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0].id).toBe(connId);
    expect(unlockFireCount).toBe(1);
    expect(talkerFactory.instances).toHaveLength(1);
    expect(talkerFactory.instances[0].state.starts[0].creds.bot.material).toEqual({
      token: "tok-1",
    });
  });

  it("settings row absent → no-op (no connection created)", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    const settings = makeSettingsSource(); // no "telegram" key at all

    await importChannelSettings(registry, settings);

    expect(registry.all()).toHaveLength(0);
  });

  it("settings row present but incomplete (no botToken) → no-op", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    const settings = makeSettingsSource({ telegram: { botUsername: "some_bot" } });

    await importChannelSettings(registry, settings);

    expect(registry.all()).toHaveLength(0);
  });

  it("ledger already authorized + settings absent → ledger wins, capability still unlocks", async () => {
    const ledger = makeLedger();

    // "Boot 1": settings present, import authorizes the grant.
    const registry1 = new ConnectionRegistry({ ledger });
    registry1.register(makeTelegramLikeDescriptor().descriptor);
    const settingsWithToken = makeSettingsSource({ telegram: { botToken: "boot1-token" } });
    await importChannelSettings(registry1, settingsWithToken);
    const connId = registry1.all()[0].id;
    expect(registry1.get(connId).talk).not.toBeNull();

    // "Boot 2": a fresh registry over the SAME ledger (simulates a reboot);
    // the settings row was deleted at some point after boot 1's import (e.g.
    // by a since-removed migration) — the ledger is the only source now.
    const registry2 = new ConnectionRegistry({ ledger });
    const { descriptor: descriptor2 } = makeTelegramLikeDescriptor();
    registry2.register(descriptor2);
    await registry2.load();

    expect(registry2.all()).toHaveLength(1);
    expect(registry2.get(connId).auth.grants().bot).toBe("authorized");
    expect(registry2.get(connId).talk).not.toBeNull();

    const emptySettings = makeSettingsSource(); // no "telegram" key
    await importChannelSettings(registry2, emptySettings);

    // The import must be a pure no-op here: no revoke, same connection, still
    // unlocked. It must NEVER tear down a rehydrated, ledger-authorized grant
    // just because the settings row went away.
    expect(registry2.all()).toHaveLength(1);
    expect(registry2.get(connId).auth.grants().bot).toBe("authorized");
    expect(registry2.get(connId).talk).not.toBeNull();
  });
});

// Boot three-way guard — bridge-era backfill + no stale resurrection

describe("importChannelSettings — three-way guard", () => {
  it("bridge-era install: authorized grant with no profile gets a profile backfilled at boot, no epoch rebuild", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    // Simulate a pre-#1548 install: the grant was authorized before profiles
    // existed, so the credential is present but the profile is absent.
    const conn = await registry.connect("telegram");
    await registry.importCredential(conn.id, "bot", {
      material: { token: "tok-1" },
      expiresAt: "never",
    });
    expect((await ledger.getGrant(conn.id, "bot"))?.profile).toBeUndefined();

    // The already-unlocked connection fires onUnlocked once on registration.
    let unlockFireCount = 0;
    registry.onUnlocked("talk", () => {
      unlockFireCount++;
    });
    expect(unlockFireCount).toBe(1);
    expect(talkerFactory.instances).toHaveLength(1);

    // Boot sweep: settings carries the SAME token plus the identity that was
    // never captured. The grant is authorized-without-profile → profile-only
    // backfill.
    const settings = makeSettingsSource({
      telegram: { botToken: "tok-1", botId: 42, botUsername: "@rome_bot" },
    });
    await importChannelSettings(registry, settings);

    const grant = await ledger.getGrant(conn.id, "bot");
    expect(grant?.state).toBe("authorized");
    expect(grant?.profile).toEqual({ botId: "42", botUsername: "@rome_bot" });
    // No epoch rebuild, no onUnlocked re-fire — the credential was never rewritten.
    expect(talkerFactory.instances).toHaveLength(1);
    expect(unlockFireCount).toBe(1);
  });

  it("a settings row whose token differs from the authorized grant does NOT resurrect the credential", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    // The ledger holds the FRESH token (e.g. rotated by a direct conferral).
    const conn = await registry.connect("telegram");
    await registry.importCredential(conn.id, "bot", {
      material: { token: "tok-fresh" },
      expiresAt: "never",
    });
    expect(talkerFactory.instances).toHaveLength(1);

    // A frozen legacy settings row still carries the STALE token.
    const settings = makeSettingsSource({
      telegram: { botToken: "tok-stale", botId: 42, botUsername: "@rome_bot" },
    });
    await importChannelSettings(registry, settings);

    const grant = await ledger.getGrant(conn.id, "bot");
    // The credential is still the fresh ledger token — never resurrected.
    expect(grant?.credential).toMatchObject({
      material: { kind: "inline", record: { token: "tok-fresh" } },
    });
    // No epoch rebuild.
    expect(talkerFactory.instances).toHaveLength(1);
    // Identity is non-secret and safe to hydrate onto a profile-less grant; only
    // the credential is protected from the stale row.
    expect(grant?.profile).toEqual({ botId: "42", botUsername: "@rome_bot" });
  });

  it("a grant that already has a profile is left fully untouched at boot", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    const conn = await registry.connect("telegram");
    await registry.importCredential(
      conn.id,
      "bot",
      { material: { token: "tok-1" }, expiresAt: "never" },
      { botId: "1", botUsername: "@original" },
    );
    expect(talkerFactory.instances).toHaveLength(1);

    // Boot sweep with a settings row carrying a DIFFERENT identity + token.
    const settings = makeSettingsSource({
      telegram: { botToken: "tok-2", botId: "2", botUsername: "@changed" },
    });
    await importChannelSettings(registry, settings);

    const grant = await ledger.getGrant(conn.id, "bot");
    // Neither the credential nor the existing profile is clobbered.
    expect(grant?.credential).toMatchObject({
      material: { kind: "inline", record: { token: "tok-1" } },
    });
    expect(grant?.profile).toEqual({ botId: "1", botUsername: "@original" });
    expect(talkerFactory.instances).toHaveLength(1);
  });

  it("an explicitly-revoked grant is NOT resurrected by a credential-bearing legacy row at boot", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    // Confer, then the guardian explicitly disconnects (revoke-only — the legacy
    // settings row stays on disk for the bridge).
    const conn = await registry.connect("telegram");
    await registry.importCredential(conn.id, "bot", {
      material: { token: "tok-1" },
      expiresAt: "never",
    });
    await conn.auth.revoke("bot");
    expect(conn.auth.grants().bot).toBe("unauthorized");
    expect(conn.talk).toBeNull();
    const epochsAfterRevoke = talkerFactory.instances.length;

    // Next boot: the sweep sees the revoke tombstone (unauthorized WITH a prior
    // conferral) and must not re-import the disconnected credential.
    const settings = makeSettingsSource({
      telegram: { botToken: "tok-1", botId: 42, botUsername: "@rome_bot" },
    });
    await importChannelSettings(registry, settings);

    const grant = await ledger.getGrant(conn.id, "bot");
    expect(grant?.state).toBe("unauthorized");
    expect(grant?.credential).toBeUndefined();
    expect(conn.talk).toBeNull();
    expect(talkerFactory.instances).toHaveLength(epochsAfterRevoke);

    // A NEW connect ceremony (route full-import) still confers normally — the
    // tombstone only blocks the boot sweep.
    await importOneChannel(registry, settings, TELEGRAM_SETTINGS_IMPORT_ROW);
    expect(conn.auth.grants().bot).toBe("authorized");
    expect(conn.talk).not.toBeNull();
  });
});

// importChannelSettings — email row (BOOT-BRIDGE-ONLY)
//
// Fresh connects confer the inbox grant directly at the route, so a fresh
// install's settings row is pure config and imports nothing — but a LEGACY
// (pre-4c) credential-bearing row must keep hydrating the grant at boot through
// the three-way guard until the post-soak bridge deletion.

/** Descriptor shaped exactly like the real Email descriptor's auth surface
 *  (service "email", grant "inbox") with a fake Talker — the bridge tests pin
 *  import/guard mechanics, not the mail transport. */
function makeEmailLikeDescriptor() {
  const talkerFactory = makeFakeTalkerFactory();
  const descriptor: ConnectionDescriptor = {
    service: "email",
    auth: {
      inbox: tokenPaste({ label: "Email inbox", validate: async () => {} }),
    },
    capabilities: {
      talker: {
        needs: ["inbox"] as const,
        build(creds) {
          return talkerFactory.build(creds);
        },
      },
    },
  };
  return { descriptor, talkerFactory };
}

describe("importChannelSettings — email (boot bridge)", () => {
  it("a legacy credential-bearing email row still hydrates the inbox grant at boot (bridge intact)", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeEmailLikeDescriptor();
    registry.register(descriptor);

    // A pre-4c install's frozen row: credentials next to config.
    const settings = makeSettingsSource({
      email: {
        enabled: true,
        address: "slug@mail.romeos.cc",
        inboundSecret: "legacy-hmac",
        guardianEmail: "g@example.com",
      },
    });
    await importChannelSettings(registry, settings);

    const conn = registry.find("email")[0];
    expect(conn.auth.grants().inbox).toBe("authorized");
    expect(conn.talk).not.toBeNull();
    // Material is the NEW shape — coords only; guardianEmail stays settings config.
    expect(talkerFactory.instances[0].state.starts[0].creds.inbox.material).toEqual({
      address: "slug@mail.romeos.cc",
      inboundSecret: "legacy-hmac",
    });
    // Profile recorded from the legacy row's provisioned address.
    const grant = await ledger.getGrant(conn.id, "inbox");
    expect(grant?.profile).toEqual({ address: "slug@mail.romeos.cc" });
  });

  it("a fresh pure-config email row imports nothing at boot (the route already conferred)", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeEmailLikeDescriptor();
    registry.register(descriptor);

    const settings = makeSettingsSource({
      email: { enabled: true, guardianEmail: "g@example.com" },
    });
    await importChannelSettings(registry, settings);

    // No coords → absent material → the boot sweep is a no-op for email.
    expect(registry.find("email")).toHaveLength(0);
    expect(talkerFactory.instances).toHaveLength(0);
  });

  it("a legacy row never resurrects over a route-conferred (rotated) inbox credential", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeEmailLikeDescriptor();
    registry.register(descriptor);

    // The connect route conferred fresh coordinates directly.
    const conn = await registry.connect("email");
    await registry.importCredential(
      conn.id,
      "inbox",
      {
        material: { address: "slug@mail.romeos.cc", inboundSecret: "fresh-hmac" },
        expiresAt: "never",
      },
      { address: "slug@mail.romeos.cc" },
    );
    expect(talkerFactory.instances).toHaveLength(1);

    // Boot sweep over a stale legacy row with the OLD secret.
    const settings = makeSettingsSource({
      email: {
        enabled: true,
        address: "slug@mail.romeos.cc",
        inboundSecret: "stale-hmac",
        guardianEmail: "g@example.com",
      },
    });
    await importChannelSettings(registry, settings);

    const grant = await ledger.getGrant(conn.id, "inbox");
    expect(grant?.credential).toMatchObject({
      material: {
        kind: "inline",
        record: { address: "slug@mail.romeos.cc", inboundSecret: "fresh-hmac" },
      },
    });
    // No epoch churn: the authorized grant's credential + profile win.
    expect(talkerFactory.instances).toHaveLength(1);
  });
});

// importOneChannel — generic row plumbing (table-driven, not telegram-special-cased)

describe("importOneChannel — generic row", () => {
  it("imports material for an arbitrary service/grant/settings-key row", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const actorFactory = makeFakeActorFactory();
    const descriptor: ConnectionDescriptor = {
      service: "widget",
      auth: {
        key: tokenPaste({
          label: "Widget API key",
          validate: async () => {},
        }),
      },
      capabilities: {
        actor: {
          needs: ["key"] as const,
          build(creds) {
            return actorFactory.build(creds);
          },
        },
      },
    };
    registry.register(descriptor);

    const row: ChannelSettingsImportRow<{ apiKey?: string }> = {
      settingsKey: "widget",
      service: "widget",
      grant: "key",
      extractMaterial: (s) => (s.apiKey ? { apiKey: s.apiKey } : null),
      extractProfile: () => null,
    };
    const settings = makeSettingsSource({ widget: { apiKey: "w-1" } });

    await importOneChannel(registry, settings, row);

    expect(registry.all()).toHaveLength(1);
    const conn = registry.all()[0];
    expect(conn.service).toBe("widget");
    expect(conn.auth.grants().key).toBe("authorized");
    expect(actorFactory.instances).toHaveLength(1);
  });

  it("reuses an existing connection for the service rather than minting a duplicate", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    // Pre-create the connection out-of-band (e.g. via load()/connect() elsewhere).
    const preConn = await registry.connect("telegram");

    const settings = makeSettingsSource({ telegram: { botToken: "tok-1" } });
    await importOneChannel(registry, settings, TELEGRAM_SETTINGS_IMPORT_ROW);

    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0].id).toBe(preConn.id);
    expect(registry.all()[0].auth.grants().bot).toBe("authorized");
  });

  it("route rotation: a changed token through importOneChannel rebuilds the epoch (full import)", async () => {
    // The route path (connect/reload) is the guardian-driven full-import path —
    // unlike the boot sweep, a rotated token here MUST reach the credential.
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor, talkerFactory } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    const settings = makeSettingsSource({ telegram: { botToken: "tok-1" } });
    await importOneChannel(registry, settings, TELEGRAM_SETTINGS_IMPORT_ROW);
    const connId = registry.all()[0].id;

    settings.set("telegram", { botToken: "tok-2" });
    await importOneChannel(registry, settings, TELEGRAM_SETTINGS_IMPORT_ROW);

    expect(registry.all()[0].id).toBe(connId);
    expect(talkerFactory.instances).toHaveLength(2);
    expect(talkerFactory.instances[1].state.starts[0].creds.bot.material).toEqual({
      token: "tok-2",
    });
  });

  it("fresh connect records the channel profile in the ledger (route flow)", async () => {
    const ledger = makeLedger();
    const registry = new ConnectionRegistry({ ledger });
    const { descriptor } = makeTelegramLikeDescriptor();
    registry.register(descriptor);

    const settings = makeSettingsSource({
      telegram: { botToken: "tok-1", botId: 424242, botUsername: "@rome_bot" },
    });
    await importOneChannel(registry, settings, TELEGRAM_SETTINGS_IMPORT_ROW);

    const conn = registry.all()[0];
    const grant = await ledger.getGrant(conn.id, "bot");
    // The identity landed on the grant row in the SAME import as the credential.
    expect(grant?.profile).toEqual({ botId: "424242", botUsername: "@rome_bot" });
  });
});

// Phase 4a rows — material extraction (pure, no registry/network)

describe("phase 4a import rows — extractMaterial", () => {
  it("discord: { token } from botToken, null when absent", () => {
    expect(DISCORD_SETTINGS_IMPORT_ROW.extractMaterial({ botToken: "d-tok" })).toEqual({
      token: "d-tok",
    });
    expect(DISCORD_SETTINGS_IMPORT_ROW.extractMaterial({})).toBeNull();
  });

  it("wechat: packs account coords, null without token/accountId", () => {
    expect(
      WECHAT_SETTINGS_IMPORT_ROW.extractMaterial({
        token: "w-tok",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "acct-1",
        userId: "u-1",
        statePath: "/tmp/wc",
      }),
    ).toEqual({
      token: "w-tok",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "acct-1",
      userId: "u-1",
      statePath: "/tmp/wc",
    });
    // baseUrl defaulted when omitted
    expect(WECHAT_SETTINGS_IMPORT_ROW.extractMaterial({ token: "t", accountId: "a" })).toEqual({
      token: "t",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "a",
    });
    expect(WECHAT_SETTINGS_IMPORT_ROW.extractMaterial({ token: "t" })).toBeNull();
    expect(WECHAT_SETTINGS_IMPORT_ROW.extractMaterial({ accountId: "a" })).toBeNull();
  });

  it("feishu: { appId, appSecret, domain, appType }, null without both creds", () => {
    expect(
      FEISHU_SETTINGS_IMPORT_ROW.extractMaterial({
        appId: "cli",
        appSecret: "sec",
        domain: "lark",
        appType: "manual",
      }),
    ).toEqual({ appId: "cli", appSecret: "sec", domain: "lark", appType: "manual" });
    // domain defaults to feishu
    expect(FEISHU_SETTINGS_IMPORT_ROW.extractMaterial({ appId: "cli", appSecret: "sec" })).toEqual({
      appId: "cli",
      appSecret: "sec",
      domain: "feishu",
    });
    expect(FEISHU_SETTINGS_IMPORT_ROW.extractMaterial({ appId: "cli" })).toBeNull();
    expect(FEISHU_SETTINGS_IMPORT_ROW.extractMaterial({ appSecret: "sec" })).toBeNull();
  });

  it("email: material is the provisioned coords of a LEGACY row; guardianEmail/enabled are config, never material", () => {
    // Fresh (pure-config) rows carry no coords → nothing to import.
    expect(EMAIL_SETTINGS_IMPORT_ROW.extractMaterial({ enabled: true })).toBeNull();
    expect(
      EMAIL_SETTINGS_IMPORT_ROW.extractMaterial({ enabled: true, guardianEmail: "g@example.com" }),
    ).toBeNull();
    // Legacy credential-bearing rows yield exactly the grant material shape —
    // guardianEmail stays behind in settings (durable config).
    expect(
      EMAIL_SETTINGS_IMPORT_ROW.extractMaterial({
        enabled: true,
        address: "slug@romeos.cc",
        inboundSecret: "hmac",
        guardianEmail: "g@example.com",
      }),
    ).toEqual({ address: "slug@romeos.cc", inboundSecret: "hmac" });
    // Half a credential is no credential.
    expect(EMAIL_SETTINGS_IMPORT_ROW.extractMaterial({ address: "a@romeos.cc" })).toBeNull();
  });

  it("telegram_user: serializes full session, null without sessionString/apiId", () => {
    expect(
      TELEGRAM_USER_SETTINGS_IMPORT_ROW.extractMaterial({
        apiId: 12345,
        apiHash: "hash",
        sessionString: "sess",
        phoneNumber: "+15551234567",
        userId: "42",
        username: "@g",
        displayName: "Guardian",
        connectedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      apiId: "12345",
      apiHash: "hash",
      sessionString: "sess",
      phoneNumber: "+15551234567",
      userId: "42",
      username: "@g",
      displayName: "Guardian",
      connectedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(TELEGRAM_USER_SETTINGS_IMPORT_ROW.extractMaterial({ apiId: 1 })).toBeNull();
    expect(TELEGRAM_USER_SETTINGS_IMPORT_ROW.extractMaterial({ sessionString: "s" })).toBeNull();
  });
});

// Phase 4c rows — profile extraction (pure, parsed through each service's schema)

describe("phase 4c import rows — extractProfile", () => {
  it("telegram: { botId, botUsername } from the getMe row, botId stringified; null when absent", () => {
    expect(
      TELEGRAM_SETTINGS_IMPORT_ROW.extractProfile({
        botToken: "t",
        botId: 424242,
        botUsername: "@rome_bot",
      }),
    ).toEqual({ botId: "424242", botUsername: "@rome_bot" });
    // Sparse-but-valid: only the token, no identity → null (nothing to record).
    expect(TELEGRAM_SETTINGS_IMPORT_ROW.extractProfile({ botToken: "t" })).toBeNull();
  });

  it("telegram: a non-string/non-number botId fails the parse loudly instead of storing a coerced string", () => {
    // Settings rows are persisted JSON — widen to the untrusted runtime shape
    // (the same widening CHANNEL_SETTINGS_IMPORT_TABLE performs) to drive a
    // malformed row. It must fail closed — never land as "[object Object]".
    const row: ChannelSettingsImportRow = TELEGRAM_SETTINGS_IMPORT_ROW;
    expect(() => row.extractProfile({ botToken: "t", botId: {} })).toThrow();
    expect(() => row.extractProfile({ botToken: "t", botId: true })).toThrow();
    // A non-finite number is not a bot id — flows through untouched and is rejected.
    expect(() => row.extractProfile({ botToken: "t", botId: Number.NaN })).toThrow();
  });

  it("wrong-typed identity values fail the parse loudly on every channel, even when falsy", () => {
    // Present-but-wrong-typed values reach the strict schema and are rejected —
    // never silently dropped (the pickRawKeys discipline, train-wide).
    const rows: Record<string, ChannelSettingsImportRow> = {
      discord: DISCORD_SETTINGS_IMPORT_ROW,
      wechat: WECHAT_SETTINGS_IMPORT_ROW,
      feishu: FEISHU_SETTINGS_IMPORT_ROW,
      email: EMAIL_SETTINGS_IMPORT_ROW,
      telegram_user: TELEGRAM_USER_SETTINGS_IMPORT_ROW,
    };
    expect(() => rows.discord.extractProfile({ botId: "999", botUsername: false })).toThrow();
    expect(() => rows.wechat.extractProfile({ accountId: 0 })).toThrow();
    expect(() => rows.feishu.extractProfile({ appId: "cli", domain: 0 })).toThrow();
    expect(() => rows.email.extractProfile({ address: false })).toThrow();
    expect(() => rows.telegram_user.extractProfile({ userId: "42", displayName: 0 })).toThrow();
  });

  it("discord: { botId, botUsername }; null when absent", () => {
    expect(
      DISCORD_SETTINGS_IMPORT_ROW.extractProfile({
        botToken: "t",
        botId: "999",
        botUsername: "rome",
      }),
    ).toEqual({ botId: "999", botUsername: "rome" });
    expect(DISCORD_SETTINGS_IMPORT_ROW.extractProfile({ botToken: "t" })).toBeNull();
  });

  it("wechat: { accountId, bound userId }; null without identity", () => {
    expect(
      WECHAT_SETTINGS_IMPORT_ROW.extractProfile({ accountId: "acct-1", userId: "guardian-7" }),
    ).toEqual({ accountId: "acct-1", userId: "guardian-7" });
    expect(WECHAT_SETTINGS_IMPORT_ROW.extractProfile({ token: "t" })).toBeNull();
  });

  it("feishu: { appId, domain, appType }; null without identity", () => {
    expect(
      FEISHU_SETTINGS_IMPORT_ROW.extractProfile({
        appId: "cli_abc",
        domain: "lark",
        appType: "manual",
      }),
    ).toEqual({ appId: "cli_abc", domain: "lark", appType: "manual" });
    expect(FEISHU_SETTINGS_IMPORT_ROW.extractProfile({ appSecret: "s" })).toBeNull();
  });

  it("email: { address } from a legacy row's provisioned coords; null for a config-only row", () => {
    expect(EMAIL_SETTINGS_IMPORT_ROW.extractProfile({ address: "slug@romeos.cc" })).toEqual({
      address: "slug@romeos.cc",
    });
    // Fresh pure-config rows carry no address → no identity to record.
    expect(
      EMAIL_SETTINGS_IMPORT_ROW.extractProfile({ enabled: true, guardianEmail: "g@example.com" }),
    ).toBeNull();
  });

  it("telegram_user: user identity + phone + connectedAt; null without identity", () => {
    expect(
      TELEGRAM_USER_SETTINGS_IMPORT_ROW.extractProfile({
        userId: "42",
        username: "@g",
        displayName: "Guardian",
        phoneNumber: "+15551234567",
        connectedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      userId: "42",
      username: "@g",
      displayName: "Guardian",
      phoneNumber: "+15551234567",
      connectedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(TELEGRAM_USER_SETTINGS_IMPORT_ROW.extractProfile({ apiId: 1 })).toBeNull();
  });

  it("whatsapp: no channel identity → always null", () => {
    expect(WHATSAPP_SETTINGS_IMPORT_ROW.extractProfile({ authStatePath: "/tmp/wa" })).toBeNull();
  });
});

// Zero-grant services (webchat)

describe("ensureZeroGrantConnections", () => {
  it("mints a webchat connection when registered + absent (idempotent)", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeWebchatDescriptor({ webchatRepo: {} as never }));

    await ensureZeroGrantConnections(registry);
    expect(registry.find("webchat")).toHaveLength(1);
    // webchat is zero-grant → unlocked at birth
    expect(registry.find("webchat")[0].talk).not.toBeNull();

    // Idempotent: a second run does not create a duplicate connection.
    await ensureZeroGrantConnections(registry);
    expect(registry.find("webchat")).toHaveLength(1);
  });

  it("skips services this registry does not declare (no throw)", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    // webchat NOT registered — must be a no-op, not a "no registered descriptor" throw.
    await expect(ensureZeroGrantConnections(registry)).resolves.toBeUndefined();
    expect(registry.find("webchat")).toHaveLength(0);
  });
});

// WhatsApp directory migration (importOneChannel special case)

describe("importOneChannel — whatsapp directory migration", () => {
  it("reads a legacy multi-file auth dir into the session grant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-mig-"));
    // Minimal creds.json is enough for readWhatsAppAuthStateFromDirectory to
    // return material (it keys off creds.json presence).
    await writeFile(join(dir, "creds.json"), JSON.stringify({ me: { id: "1@s.whatsapp.net" } }));

    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    // A whatsapp-shaped descriptor with a fake Talker (no Baileys socket).
    const talkerFactory = makeFakeTalkerFactory();
    registry.register({
      service: "whatsapp",
      auth: { session: tokenPaste({ label: "s", validate: async () => {} }) },
      capabilities: {
        talker: { needs: ["session"] as const, build: (creds) => talkerFactory.build(creds) },
      },
    });

    const settings = makeSettingsSource({ whatsapp: { authStatePath: dir } });
    await importOneChannel(registry, settings, WHATSAPP_SETTINGS_IMPORT_ROW);

    const conn = registry.find("whatsapp")[0];
    expect(conn).toBeDefined();
    expect(conn.auth.grants().session).toBe("authorized");
  });

  it("no-op when the directory has no creds.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-empty-"));
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    const talkerFactory = makeFakeTalkerFactory();
    registry.register({
      service: "whatsapp",
      auth: { session: tokenPaste({ label: "s", validate: async () => {} }) },
      capabilities: {
        talker: { needs: ["session"] as const, build: (creds) => talkerFactory.build(creds) },
      },
    });

    const settings = makeSettingsSource({ whatsapp: { authStatePath: dir } });
    await importOneChannel(registry, settings, WHATSAPP_SETTINGS_IMPORT_ROW);

    // Connection minted, but no session imported (grant stays unauthorized).
    expect(registry.find("whatsapp")[0]?.auth.grants().session).toBe("unauthorized");
  });
});
