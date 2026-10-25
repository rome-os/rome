// Seam under test: ConnectionRegistry.confer refusing an account that another
// Connection of the service already holds, directly and through a SetupManager
// setup. Observed through the ledger and the setup state.

import { describe, expect, it } from "@rstest/core";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createTestDb } from "../test/helpers.js";
import { AccountAlreadyConnectedError, DifferentAccountError } from "./errors.js";
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

  it("refuses a different bot on a Connection that still names its own", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });

      const refused = registry.confer(SERVICE, first.id, "bot", credentialFor("t-9"), {
        botId: "900",
      });

      await expect(refused).rejects.toBeInstanceOf(DifferentAccountError);
      await expect(ledger.getGrant(first.id, "bot")).resolves.toMatchObject({
        profile: { botId: "100" },
      });
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
      const firstSetup = await manager.start(
        { connectionKind: SERVICE, connectionId: first.id },
        "bot",
      );
      const done = await manager.provideInput(firstSetup.cid, { token: "t-1", botId: "100" });
      expect(done?.state.status).toBe("done");

      const second = await registry.connectAnother(SERVICE);
      const secondSetup = await manager.start(
        { connectionKind: SERVICE, connectionId: second.id },
        "bot",
      );
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

  it("records the account a grant reaches, and clears it on disconnect", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      expect((await ledger.getGrant(first.id, "bot"))?.account).toEqual({
        platform: SERVICE,
        accountId: "100",
      });

      await registry.revoke(first.id, "bot");

      expect((await ledger.getGrant(first.id, "bot"))?.account).toBeUndefined();
    } finally {
      close();
    }
  });

  it("refuses an account a connection of another kind on its platform reaches", async () => {
    const db = createTestDb();
    try {
      const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db.db) });
      const { descriptor } = makePasteTalk();
      registry.register({ ...descriptor, connectionKind: "telegram" });
      registry.register({ ...descriptor, connectionKind: "telegram_user" });
      const bot = await registry.connect("telegram");
      await registry.confer("telegram", bot.id, "bot", credentialFor("t-1"), { botId: "100" });
      const user = await registry.connect("telegram_user");

      const refused = registry.confer("telegram_user", user.id, "bot", credentialFor("s-1"), {
        botId: "100",
      });

      await expect(refused).rejects.toMatchObject({
        name: "AccountAlreadyConnectedError",
        connectionId: bot.id,
      });
    } finally {
      db.close();
    }
  });

  it("lets the same id on another platform connect", async () => {
    const db = createTestDb();
    try {
      const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db.db) });
      const { descriptor } = makePasteTalk();
      registry.register({ ...descriptor, connectionKind: "feishu", severalAccounts: true });
      const feishu = await registry.connect("feishu");
      await registry.confer("feishu", feishu.id, "bot", credentialFor("t-1"), { botId: "100" });
      const lark = await registry.connectAnother("feishu");

      await registry.confer("feishu", lark.id, "bot", credentialFor("t-2"), {
        botId: "100",
        domain: "lark",
      });

      expect(lark.state()).toBe("working");
    } finally {
      db.close();
    }
  });

  it("refuses a different bot on a Connection the boot pass left without an account", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.confer(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      // As for the later of two connections that reached one account.
      await ledger.updateGrant(first.id, "bot", { account: undefined });

      const refused = registry.confer(SERVICE, first.id, "bot", credentialFor("t-9"), {
        botId: "900",
      });

      await expect(refused).rejects.toBeInstanceOf(DifferentAccountError);
    } finally {
      close();
    }
  });
});

describe("ConnectionRegistry account participants", () => {
  it("hands the account a grant reaches to the mint, and to a later conferral", async () => {
    const db = createTestDb();
    const minted: Array<{ kind: string; accountId?: string }> = [];
    const recorded: Array<{ id: string; accountId: string }> = [];
    const registry = new ConnectionRegistry({
      ledger: new DrizzleGrantLedger(db.db),
      onMint: (_tx, record, _profile, account) =>
        minted.push({ kind: record.connectionKind, accountId: account?.accountId }),
      onAccount: (_tx, id, account) => recorded.push({ id, accountId: account.accountId }),
    });
    registry.register(botIdDescriptor());
    try {
      await registry.confer(SERVICE, undefined, "bot", credentialFor("t-1"), { botId: "100" });
      const placeholder = await registry.connectAnother(SERVICE);
      await registry.confer(SERVICE, placeholder.id, "bot", credentialFor("t-2"), {
        botId: "200",
      });

      expect(minted).toEqual([
        { kind: SERVICE, accountId: "100" },
        { kind: SERVICE, accountId: undefined },
      ]);
      expect(recorded).toEqual([{ id: placeholder.id, accountId: "200" }]);
    } finally {
      db.close();
    }
  });
});

describe("ConnectionRegistry account records", () => {
  it("moves a Connection kept across a revoke to the record of the account it reaches next", async () => {
    const db = createTestDb();
    const records = new ChannelRecordsRepository(db.db);
    const registry = new ConnectionRegistry({
      ledger: new DrizzleGrantLedger(db.db),
      onMint: (tx, record, _profile, account) =>
        records.claim(tx, { ...record, accountId: account?.accountId }, record.createdAt),
      onAccount: (tx, id, account) => records.recordAccount(tx, id, account.accountId),
      onRemove: (tx, id) => records.vacate(tx, id),
    });
    registry.register(botIdDescriptor());
    try {
      const conn = await registry.confer(SERVICE, undefined, "bot", credentialFor("t-1"), {
        botId: "100",
      });
      const first = records.byConnection(conn.id);
      expect(first?.platformAccountId).toBe("100");

      await registry.revoke(conn.id, "bot");
      await registry.confer(SERVICE, conn.id, "bot", credentialFor("t-2"), { botId: "200" });
      expect(records.byConnection(conn.id)?.platformAccountId).toBe("200");
      expect(records.byId(first!.id)).toMatchObject({
        connectionId: null,
        platformAccountId: "100",
      });

      await registry.revoke(conn.id, "bot");
      await registry.confer(SERVICE, conn.id, "bot", credentialFor("t-3"), { botId: "100" });
      expect(records.byConnection(conn.id)?.id).toBe(first!.id);
    } finally {
      db.close();
    }
  });
});
