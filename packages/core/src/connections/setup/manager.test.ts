// Seams under test: the SetupManager public interface — `start`, `state`,
// `activeFor`, `cancelActive`, `provideInput`, `cancel` — over a fake registry
// whose descriptor declares a setup. We observe re-attach semantics, that the
// terminal write imports into the ADDRESSED connection (never blindly
// find()[0]), and the guardian map — never reaching into the manager internals.

import { describe, expect, it, rs } from "@rstest/core";
import type { DrizzleTx } from "../../db/index.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import type { Connection, ConnectionDescriptor, Credential, ProfileRecord } from "../types.js";
import { SetupManager, NoSetupError, type SetupRegistry } from "./manager.js";
import type { SetupFn } from "./types.js";

/** A stand-in transaction handle for the fake registry's `confer` participant. */
const FAKE_TX = {} as unknown as DrizzleTx;

const CRED: Credential = { material: { token: "t" }, expiresAt: "never" };

/** The Discord-shaped setup used across these tests: prompt a token, then
 *  confer credential + profile + guardian mapping. */
const discordSetup: SetupFn = async (interact) => {
  const { token } = await interact.prompt({
    fields: [{ name: "token", label: "Token", secret: true }],
  });
  return {
    credential: { material: { token }, expiresAt: "never" },
    profile: { botUsername: "rome" },
    guardianChannelUserId: "guardian-1",
  };
};

const mkConn = (id: string, service = "discord"): Connection =>
  ({ id, service }) as unknown as Connection;

/** A registry double whose `confer` records the terminal write and runs sections
 *  inline. `seed` pre-populates existing connections (for addressed-connection
 *  tests). `mint` stands in for the placeholder mint so the tests can assert
 *  whether a connection was created. */
function fakeRegistry(setup: SetupFn | undefined, seed: Connection[] = []) {
  const imports: Array<{
    id: string;
    grant: string;
    credential: Credential;
    profile?: ProfileRecord;
  }> = [];
  let connected: Connection[] = [...seed];
  const mint = rs.fn((service: string): Connection => {
    const conn = mkConn(`conn-${service}`, service);
    connected = [...connected, conn];
    return conn;
  });
  const descriptor = {
    service: "discord",
    auth: {
      bot: {
        confer: async () => CRED,
        renew: async () => "re-confer" as const,
        ...(setup ? { setup } : {}),
      },
    },
    capabilities: {},
  } as unknown as ConnectionDescriptor;
  const registry: SetupRegistry = {
    getDescriptor: () => descriptor,
    withGrantSection: (_s, _g, fn) => fn(),
    confer: async (service, connectionId, grant, credential, profile, opts) => {
      let conn = connectionId
        ? connected.find((c) => c.id === connectionId)
        : connected.find((c) => c.service === service);
      if (connectionId && !conn) {
        throw new Error(`Connection "${connectionId}" no longer exists; setup cannot confer.`);
      }
      if (!conn) conn = mint(service);
      // The atomic write: record the credential, then run the guardian-mapping
      // participant exactly as the real `confer` does inside its transaction.
      imports.push({ id: conn.id, grant, credential, profile });
      opts?.inTx?.(FAKE_TX);
      return conn;
    },
  };
  return { registry, imports, connect: mint };
}

/** A person-mapping repo double; `writeChannelMapping` is the guardian-map sink
 *  (the participant the conferral transaction runs). */
function fakePersonRepo(writeChannelMapping = rs.fn(() => "id")): PersonMappingRepository {
  return {
    findByChannelUser: async () => null,
    findByBondLevel: async () => [{ id: "guardian", channelMappings: [] }],
    writeChannelUserId: () => {},
    writeChannelMapping,
  } as unknown as PersonMappingRepository;
}

const PLACEHOLDER = { service: "discord" } as const;

describe("SetupManager", () => {
  it("starts a setup and exposes its initial awaiting-input state", async () => {
    const { registry } = fakeRegistry(discordSetup);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const started = await mgr.start(PLACEHOLDER, "bot");
    expect(started.reattached).toBe(false);
    expect(started.state.status).toBe("awaiting-input");
    expect(mgr.activeFor("discord", "bot")).toBe(started.cid);
    expect(mgr.state(started.cid)?.status).toBe("awaiting-input");
  });

  it("re-attaches a duplicate start to the live setup (same cid)", async () => {
    const { registry } = fakeRegistry(discordSetup);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const first = await mgr.start(PLACEHOLDER, "bot");
    const second = await mgr.start(PLACEHOLDER, "bot");
    expect(second.reattached).toBe(true);
    expect(second.cid).toBe(first.cid);
  });

  it("force-starts a fresh setup, cancelling the prior one", async () => {
    const { registry } = fakeRegistry(discordSetup);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const first = await mgr.start(PLACEHOLDER, "bot");
    const forced = await mgr.start(PLACEHOLDER, "bot", { force: true });
    expect(forced.cid).not.toBe(first.cid);
    expect(mgr.state(first.cid)).toEqual({ status: "cancelled" });
    expect(mgr.activeFor("discord", "bot")).toBe(forced.cid);
  });

  it("placeholder flow: mints the connection, imports, and maps the guardian", async () => {
    const { registry, imports, connect } = fakeRegistry(discordSetup);
    const writeChannelMapping = rs.fn(() => "id");
    const mgr = new SetupManager({
      registry,
      personMappingRepo: fakePersonRepo(writeChannelMapping),
    });
    const started = await mgr.start(PLACEHOLDER, "bot");
    const outcome = await mgr.provideInput(started.cid, { token: "abc" })!;
    expect(outcome.state.status).toBe("done");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(imports).toEqual([
      {
        id: "conn-discord",
        grant: "bot",
        credential: { material: { token: "abc" }, expiresAt: "never" },
        profile: { botUsername: "rome" },
      },
    ]);
    expect(writeChannelMapping).toHaveBeenCalledWith(FAKE_TX, "guardian", "discord", "guardian-1");
  });

  it("imports into the ADDRESSED connection, never find()[0]", async () => {
    // Two connections for the same service; setup targets the SECOND.
    const { registry, imports, connect } = fakeRegistry(discordSetup, [
      mkConn("conn-A"),
      mkConn("conn-B"),
    ]);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const started = await mgr.start({ service: "discord", connectionId: "conn-B" }, "bot");
    expect(mgr.activeFor("conn-B", "bot")).toBe(started.cid);
    await mgr.provideInput(started.cid, { token: "abc" })!;
    expect(connect).not.toHaveBeenCalled();
    expect(imports.map((i) => i.id)).toEqual(["conn-B"]);
  });

  it("fails the setup when the addressed connection has vanished (no resurrection)", async () => {
    const { registry, imports, connect } = fakeRegistry(discordSetup, []);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const started = await mgr.start({ service: "discord", connectionId: "gone" }, "bot");
    const outcome = await mgr.provideInput(started.cid, { token: "abc" })!;
    expect(outcome.state.status).toBe("failed");
    expect(connect).not.toHaveBeenCalled();
    expect(imports).toEqual([]);
  });

  it("begins fresh after an explicit cancel", async () => {
    const { registry } = fakeRegistry(discordSetup);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const first = await mgr.start(PLACEHOLDER, "bot");
    await mgr.cancel(first.cid);
    expect(mgr.activeFor("discord", "bot")).toBeNull();
    const second = await mgr.start(PLACEHOLDER, "bot");
    expect(second.cid).not.toBe(first.cid);
    expect(second.reattached).toBe(false);
  });

  it("cancelActive cancels a live setup for the addressed grant", async () => {
    const { registry } = fakeRegistry(discordSetup, [mkConn("conn-A")]);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const started = await mgr.start({ service: "discord", connectionId: "conn-A" }, "bot");
    await mgr.cancelActive("conn-A", "bot");
    expect(mgr.state(started.cid)).toEqual({ status: "cancelled" });
    expect(mgr.activeFor("conn-A", "bot")).toBeNull();
    // No-op when nothing is active.
    await expect(mgr.cancelActive("conn-A", "bot")).resolves.toBeUndefined();
  });

  it("serializes concurrent forced starts so exactly one setup stays active", async () => {
    const { registry } = fakeRegistry(discordSetup);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    const first = await mgr.start(PLACEHOLDER, "bot");

    // Two forced starts fired concurrently must not both survive.
    const [a, b] = await Promise.all([
      mgr.start(PLACEHOLDER, "bot", { force: true }),
      mgr.start(PLACEHOLDER, "bot", { force: true }),
    ]);

    const active = mgr.activeFor("discord", "bot");
    expect(active).toBeTruthy();
    // The active one is one of the two; every other session is terminal.
    const cids = [first.cid, a.cid, b.cid];
    expect(cids).toContain(active);
    for (const cid of cids) {
      if (cid !== active) expect(mgr.state(cid)).toEqual({ status: "cancelled" });
    }
    // Exactly one non-terminal session across all three starts.
    const liveCount = cids.filter((cid) => mgr.state(cid)?.status !== "cancelled").length;
    expect(liveCount).toBe(1);
  });

  it("throws NoSetupError when the grant declares no setup", async () => {
    const { registry } = fakeRegistry(undefined);
    const mgr = new SetupManager({ registry, personMappingRepo: fakePersonRepo() });
    await expect(mgr.start(PLACEHOLDER, "bot")).rejects.toBeInstanceOf(NoSetupError);
  });
});
