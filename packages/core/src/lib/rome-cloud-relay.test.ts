import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { createFetchRecorder, type FetchRecorder } from "../test/kit/index.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { RELAY_SETTING_KEY, type RelayDrainSetting } from "../relay/settings.js";
import type { RelayDrain } from "../relay/drainer.js";
import { ensureRelayMailbox } from "./rome-cloud-relay.js";
import { setInstanceTokenInMemory } from "./instance-identity.js";

// ensureRelayMailbox is the instance-token relay provisioning seam:
// the instance presents its durable token to Rome Cloud's mint endpoint and ends
// up with a persisted relay credential + a re-pointed drainer. These drive it as
// a black box — fetchRecorder plays Rome Cloud at the HTTP edge, a real
// SettingsRepository over an in-memory DB is the observable store — so the
// assertions are on what an operator would see (the stored setting), not mocks.

const INSTANCE_TOKEN = "romeinst_testtoken";
const ROME_CLOUD_ORIGIN = "https://rome-cloud.example";
const MINT_URL = `${ROME_CLOUD_ORIGIN}/api/relay/mailboxes`;

describe("ensureRelayMailbox (instance-token relay provisioning)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let settingsRepo: SettingsRepository;
  let reloads: RelayDrain[][];
  let http: FetchRecorder;
  const relayDrainer = {
    reload: async (drains: RelayDrain[]) => {
      reloads.push(drains);
    },
  };
  // A catalog with no relay-webhook consumer: resolveRelayDrains yields [], which
  // is enough to assert the drainer is re-pointed. Drain *contents* are covered
  // by the relay/settings tests; here we pin the provisioning behaviour.
  const appCatalog = { listResolved: () => [] as never[] };

  const ORIGINAL_ENV = { ...process.env };

  const deps = () => ({ settingsRepo, appCatalog, relayDrainer, fetch: http.fetch });

  beforeEach(() => {
    testDb = createTestDb();
    settingsRepo = new SettingsRepository(testDb.db);
    reloads = [];
    http = createFetchRecorder();
    setInstanceTokenInMemory(null);
    delete process.env.PANTHEON_DOMAIN;
    process.env.PANTHEON_BASE_ORIGIN = ROME_CLOUD_ORIGIN;
  });

  afterEach(() => {
    testDb.close();
    setInstanceTokenInMemory(null);
    process.env = { ...ORIGINAL_ENV };
  });

  it("provisions the mailbox and persists the minted credential when enrolled", async () => {
    http.when("POST", MINT_URL).reply(200, {
      mailboxId: "MBOX",
      connectUrl: "wss://relay.example/c/MBOX",
      drainKey: "99.sig",
      // depositUrl intentionally omitted — core derives the /h/ face.
    });
    setInstanceTokenInMemory(INSTANCE_TOKEN);

    const result = await ensureRelayMailbox(deps());

    expect(result).toEqual({ status: "provisioned", mailboxId: "MBOX" });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].headers.get("authorization")).toBe(`Bearer ${INSTANCE_TOKEN}`);
    expect(await settingsRepo.get<RelayDrainSetting>(RELAY_SETTING_KEY)).toEqual({
      drainUrl: "wss://relay.example/c/MBOX",
      drainKey: "99.sig",
      depositUrl: "https://relay.example/h/MBOX",
    });
    // Drainer was re-pointed exactly once at the freshly-minted credential.
    expect(reloads).toHaveLength(1);
  });

  it("stores a Rome Cloud-supplied deposit URL as-is instead of deriving one", async () => {
    http.when("POST", MINT_URL).reply(200, {
      mailboxId: "MBOX",
      connectUrl: "wss://relay.example/c/MBOX",
      drainKey: "99.sig",
      depositUrl: "https://hooks.example/h/MBOX",
    });
    setInstanceTokenInMemory(INSTANCE_TOKEN);

    await ensureRelayMailbox(deps());

    expect((await settingsRepo.get<RelayDrainSetting>(RELAY_SETTING_KEY))?.depositUrl).toBe(
      "https://hooks.example/h/MBOX",
    );
  });

  it("leaves an existing relay setting untouched when the instance is not enrolled", async () => {
    const manual: RelayDrainSetting = {
      drainUrl: "wss://manual.example/c/PASTED",
      drainKey: "manual-key",
      depositUrl: "https://manual.example/h/PASTED",
    };
    await settingsRepo.set(RELAY_SETTING_KEY, manual);
    // No ROME_INSTANCE_TOKEN → not enrolled. Rome Cloud must never be contacted.

    const result = await ensureRelayMailbox(deps());

    expect(result).toEqual({ status: "not_enrolled" });
    expect(http.calls).toHaveLength(0);
    expect(await settingsRepo.get<RelayDrainSetting>(RELAY_SETTING_KEY)).toEqual(manual);
    expect(reloads).toHaveLength(0);
  });

  it("reports rejection and writes nothing when the instance token is revoked", async () => {
    http.when("POST", MINT_URL).reply(403, { error: "instance_revoked" });
    setInstanceTokenInMemory(INSTANCE_TOKEN);

    const result = await ensureRelayMailbox(deps());

    expect(result).toEqual({ status: "rejected", reason: "revoked" });
    expect(await settingsRepo.get(RELAY_SETTING_KEY)).toBeNull();
    expect(reloads).toHaveLength(0);
  });

  it("reports rejection and writes nothing when the instance token is unknown (401)", async () => {
    http.when("POST", MINT_URL).reply(401, { error: "invalid_instance_token" });
    setInstanceTokenInMemory(INSTANCE_TOKEN);

    const result = await ensureRelayMailbox(deps());

    expect(result).toEqual({ status: "rejected", reason: "unknown" });
    expect(await settingsRepo.get(RELAY_SETTING_KEY)).toBeNull();
    expect(reloads).toHaveLength(0);
  });

  it("treats a 409 from mailbox minting as an unexpected rejection", async () => {
    http.when("POST", MINT_URL).reply(409, { error: "linked_instance_quota_exceeded" });
    setInstanceTokenInMemory(INSTANCE_TOKEN);

    const result = await ensureRelayMailbox(deps());

    expect(result).toEqual({
      status: "error",
      message: "Rome Cloud rejected relay mailbox provisioning.",
    });
    expect(await settingsRepo.get(RELAY_SETTING_KEY)).toBeNull();
    expect(reloads).toHaveLength(0);
  });

  it("reports unreachable and writes nothing on a network failure", async () => {
    http.when("POST", MINT_URL).failWith(new Error("ECONNREFUSED"));
    setInstanceTokenInMemory(INSTANCE_TOKEN);

    const result = await ensureRelayMailbox(deps());

    expect(result).toEqual({ status: "unreachable" });
    // The scripted failure — not a mismatched URL — is what produced it.
    expect(http.unmatched).toHaveLength(0);
    expect(await settingsRepo.get(RELAY_SETTING_KEY)).toBeNull();
    expect(reloads).toHaveLength(0);
  });

  it("fails closed on a 200 missing a required credential field", async () => {
    http.when("POST", MINT_URL).reply(200, {
      mailboxId: "MBOX",
      connectUrl: "wss://relay.example/c/MBOX",
      // drainKey missing — a malformed payload must not be persisted.
    });
    setInstanceTokenInMemory(INSTANCE_TOKEN);

    const result = await ensureRelayMailbox(deps());

    expect(result).toEqual({
      status: "error",
      message: "Rome Cloud returned an invalid relay mailbox payload.",
    });
    expect(await settingsRepo.get(RELAY_SETTING_KEY)).toBeNull();
    expect(reloads).toHaveLength(0);
  });
});
