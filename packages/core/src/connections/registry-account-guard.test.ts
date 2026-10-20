// Seam under test: ConnectionRegistry.confer refusing an account that another
// Connection of the service already holds, directly and through a SetupManager
// setup. Observed through the ledger and the setup state.

import { describe, expect, it } from "@rstest/core";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { createTestDb } from "../test/helpers.js";
import { AccountAlreadyConnectedError } from "./errors.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import { SetupManager } from "./setup/manager.js";
import type { SetupFn } from "./setup/types.js";
import { makePasteTalk } from "./test-fixtures.js";
import type { ConnectionDescriptor, Credential } from "./types.js";

const SERVICE = "fake-telegram";

/** The paste-talk descriptor, naming its account by the profile's `botId`
 *  the way the Telegram descriptor does. */
function botIdDescriptor(setup?: SetupFn): ConnectionDescriptor {
  const { descriptor } = makePasteTalk();
  return {
    ...descriptor,
    severalAccounts: true,
    accountIdOf: (_grant, profile) => (typeof profile.botId === "string" ? profile.botId : null),
    auth: setup ? { bot: { ...descriptor.auth.bot!, setup } } : descriptor.auth,
  };
}

const credentialFor = (token: string): Credential => ({
  material: { token },
  expiresAt: "never",
});

function setupRegistry(setup?: SetupFn) {
  const db = createTestDb();
  const ledger = new DrizzleGrantLedger(db.db);
  const registry = new ConnectionRegistry({ ledger });
  registry.register(botIdDescriptor(setup));
  return { ...db, ledger, registry };
}

describe("ConnectionRegistry.confer account guard", () => {
  it("refuses a bot another Connection of the service holds, and writes nothing", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      const second = await registry.connectAnother(SERVICE);

      const refused = registry.confer(SERVICE, second.id, "bot", credentialFor("t-1b"), {
        botId: "100",
      });

      await expect(refused).rejects.toBeInstanceOf(AccountAlreadyConnectedError);
      await expect(refused).rejects.toMatchObject({ connectionId: first.id, accountId: "100" });
      await expect(ledger.getGrant(second.id, "bot")).resolves.toMatchObject({
        state: "unauthorized",
      });
      expect((await ledger.getGrant(second.id, "bot"))?.profile).toBeUndefined();
      expect(second.isUnlocked("talk")).toBe(false);
    } finally {
      close();
    }
  });

  it("lets the same Connection confer its own bot again", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });

      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-2"), { botId: "100" });

      await expect(ledger.getGrant(first.id, "bot")).resolves.toMatchObject({
        state: "authorized",
        profile: { botId: "100" },
      });
    } finally {
      close();
    }
  });

  it("lets a second Connection confer a different bot", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      const second = await registry.connectAnother(SERVICE);

      await registry.confer(SERVICE, second.id, "bot", credentialFor("t-2"), { botId: "200" });

      await expect(ledger.getGrant(second.id, "bot")).resolves.toMatchObject({
        state: "authorized",
        profile: { botId: "200" },
      });
    } finally {
      close();
    }
  });

  it("lets a second Connection take a bot the first one revoked", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      await registry.revoke(first.id, "bot");
      const second = await registry.connectAnother(SERVICE);

      await registry.confer(SERVICE, second.id, "bot", credentialFor("t-1"), { botId: "100" });

      await expect(ledger.getGrant(second.id, "bot")).resolves.toMatchObject({
        state: "authorized",
      });
    } finally {
      close();
    }
  });

  it("fails the second Connection's setup with the guardian-readable reason", async () => {
    const pasteBot: SetupFn = async (interact) => {
      const { token, botId } = await interact.prompt({
        fields: [
          { name: "token", label: "Token", secret: true },
          { name: "botId", label: "Bot id", secret: false },
        ],
      });
      return { credential: credentialFor(token!), profile: { botId } };
    };
    const { ledger, registry, close } = setupRegistry(pasteBot);
    try {
      const manager = new SetupManager({
        registry,
        personMappingRepo: {} as PersonMappingRepository,
      });
      const first = await registry.connect(SERVICE);
      const firstSetup = await manager.start({ service: SERVICE, connectionId: first.id }, "bot");
      const done = await manager.provideInput(firstSetup.cid, { token: "t-1", botId: "100" });
      expect(done?.state.status).toBe("done");

      const second = await registry.connectAnother(SERVICE);
      const secondSetup = await manager.start({ service: SERVICE, connectionId: second.id }, "bot");
      const outcome = await manager.provideInput(secondSetup.cid, { token: "t-1b", botId: "100" });

      expect(outcome?.state).toEqual({
        status: "failed",
        reason: new AccountAlreadyConnectedError(SERVICE, "100", first.id).message,
      });
      await expect(ledger.getGrant(second.id, "bot")).resolves.toMatchObject({
        state: "unauthorized",
      });
    } finally {
      close();
    }
  });

  it("names the account a minting conferral connected to onMint", async () => {
    const db = createTestDb();
    try {
      const minted: Array<{ id: string; account: string | null }> = [];
      const registry = new ConnectionRegistry({
        ledger: new DrizzleGrantLedger(db.db),
        onMint: (_tx, record, account) => minted.push({ id: record.id, account }),
      });
      registry.register(botIdDescriptor());

      const conn = await registry.confer(SERVICE, undefined, "bot", credentialFor("t-1"), {
        botId: "100",
      });
      const bare = await registry.connectAnother(SERVICE);

      expect(minted).toEqual([
        { id: conn.id, account: "100" },
        { id: bare.id, account: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("names the account a conferral onto an existing Connection connected to onConfer", async () => {
    const db = createTestDb();
    try {
      const conferred: Array<{ id: string; account: string }> = [];
      const registry = new ConnectionRegistry({
        ledger: new DrizzleGrantLedger(db.db),
        onConfer: (_tx, id, account) => conferred.push({ id, account }),
      });
      registry.register(botIdDescriptor());
      const conn = await registry.connect(SERVICE);

      await registry.confer(SERVICE, conn.id, "bot", credentialFor("t-1"), { botId: "100" });
      await registry.confer(SERVICE, conn.id, "bot", credentialFor("t-2"), {});

      expect(conferred).toEqual([{ id: conn.id, account: "100" }]);
    } finally {
      db.close();
    }
  });
});
