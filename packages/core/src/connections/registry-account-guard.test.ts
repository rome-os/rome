// Seam under test: ConnectionRegistry.giveGrant refusing an account that another
// Connection of the service already holds, directly and through a SetupManager
// setup. Observed through the ledger and the setup state.

import { describe, expect, it } from "@rstest/core";
import type { PeopleRepository } from "../db/repositories/people.js";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createTestDb, testAccountLinkOf } from "../test/helpers.js";
import { AccountAlreadyConnectedError, DifferentAccountError } from "./errors.js";
import { DrizzleConnectionsRepository } from "./repository-db.js";
import { ConnectionRegistry } from "./registry.js";
import { SetupManager } from "./setup/manager.js";
import type { SetupFn } from "./setup/types.js";
import { makePasteTalk, updateGrant } from "./test-fixtures.js";
import type { ConnectionDescriptor, Credential } from "./types.js";

const SERVICE = "fake-telegram";

/** The paste-talk descriptor, naming its account by the profile's `botId`
 *  the way the Telegram descriptor does. */
function botIdDescriptor(setup?: SetupFn): ConnectionDescriptor {
  const { descriptor } = makePasteTalk();
  return {
    ...descriptor,
    severalAccounts: true,
    accountIdOf: (profile) => (typeof profile.botId === "string" ? profile.botId : null),
    auth: setup ? { ...descriptor.auth, setup } : descriptor.auth,
  };
}

const credentialFor = (token: string): Credential => ({
  material: { token },
  expiresAt: "never",
});

function setupRegistry(setup?: SetupFn) {
  const db = createTestDb();
  const ledger = new DrizzleConnectionsRepository(db.db);
  const registry = new ConnectionRegistry({ repository: ledger });
  registry.register(botIdDescriptor(setup));
  return { ...db, ledger, registry };
}

describe("ConnectionRegistry.giveGrant account guard", () => {
  it("refuses a bot another Connection of the service holds, and writes nothing", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      const second = await registry.connectAnother(SERVICE);

      const refused = registry.giveGrant(SERVICE, second.id, "bot", credentialFor("t-1b"), {
        botId: "100",
      });

      await expect(refused).rejects.toBeInstanceOf(AccountAlreadyConnectedError);
      await expect(refused).rejects.toMatchObject({ connectionId: first.id, accountId: "100" });
      await expect(ledger.grantOf(second.id)).resolves.toMatchObject({
        state: "unauthorized",
      });
      expect((await ledger.grantOf(second.id))?.profile).toBeUndefined();
      expect(second.isUnlocked("chat")).toBe(false);
    } finally {
      close();
    }
  });

  it("refuses a different bot on a Connection that still names its own", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });

      const refused = registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-9"), {
        botId: "900",
      });

      await expect(refused).rejects.toBeInstanceOf(DifferentAccountError);
      await expect(ledger.grantOf(first.id)).resolves.toMatchObject({
        profile: { botId: "100" },
      });
    } finally {
      close();
    }
  });

  it("lets the same Connection grant its own bot again", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });

      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-2"), { botId: "100" });

      await expect(ledger.grantOf(first.id)).resolves.toMatchObject({
        state: "authorized",
        profile: { botId: "100" },
      });
    } finally {
      close();
    }
  });

  it("replaces the grant whole, so a fix with no profile leaves none behind", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      await updateGrant(ledger, first.id, (current) => ({
        ...current,
        state: "degraded",
        degraded: { at: new Date(0), reason: "token revoked upstream" },
      }));

      await registry.giveGrant(first.connectionKind, first.id, "bot", credentialFor("t-2"));

      const grant = await ledger.grantOf(first.id);
      expect(grant).toMatchObject({ state: "authorized" });
      expect(grant?.profile).toBeUndefined();
      expect(grant?.account).toBeUndefined();
      expect(grant?.degraded).toBeUndefined();
    } finally {
      close();
    }
  });

  it("lets a second Connection grant a different bot", async () => {
    const { ledger, registry, close } = setupRegistry();
    try {
      const first = await registry.connect(SERVICE);
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      const second = await registry.connectAnother(SERVICE);

      await registry.giveGrant(SERVICE, second.id, "bot", credentialFor("t-2"), { botId: "200" });

      await expect(ledger.grantOf(second.id)).resolves.toMatchObject({
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
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      await registry.revoke(first.id, "bot");
      const second = await registry.connectAnother(SERVICE);

      await registry.giveGrant(SERVICE, second.id, "bot", credentialFor("t-1"), { botId: "100" });

      await expect(ledger.grantOf(second.id)).resolves.toMatchObject({
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
        peopleRepo: {} as PeopleRepository,
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
      await expect(ledger.grantOf(second.id)).resolves.toMatchObject({
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
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      expect((await ledger.grantOf(first.id))?.account).toEqual({
        platform: SERVICE,
        accountId: "100",
      });

      await registry.revoke(first.id, "bot");

      expect((await ledger.grantOf(first.id))?.account).toBeUndefined();
    } finally {
      close();
    }
  });

  it("refuses an account a connection of another kind on its platform reaches", async () => {
    const db = createTestDb();
    try {
      const registry = new ConnectionRegistry({
        repository: new DrizzleConnectionsRepository(db.db),
      });
      const { descriptor } = makePasteTalk();
      registry.register({ ...descriptor, connectionKind: "telegram" });
      registry.register({ ...descriptor, connectionKind: "telegram_user" });
      const bot = await registry.connect("telegram");
      await registry.giveGrant("telegram", bot.id, "bot", credentialFor("t-1"), { botId: "100" });
      const user = await registry.connect("telegram_user");

      const refused = registry.giveGrant("telegram_user", user.id, "bot", credentialFor("s-1"), {
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
      const registry = new ConnectionRegistry({
        repository: new DrizzleConnectionsRepository(db.db),
      });
      const { descriptor } = makePasteTalk();
      registry.register({ ...descriptor, connectionKind: "feishu", severalAccounts: true });
      const feishu = await registry.connect("feishu");
      await registry.giveGrant("feishu", feishu.id, "bot", credentialFor("t-1"), { botId: "100" });
      const lark = await registry.connectAnother("feishu");

      await registry.giveGrant("feishu", lark.id, "bot", credentialFor("t-2"), {
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
      await registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-1"), { botId: "100" });
      // As for the later of two connections that reached one account.
      await updateGrant(ledger, first.id, (current) => ({ ...current, account: undefined }));

      const refused = registry.giveGrant(SERVICE, first.id, "bot", credentialFor("t-9"), {
        botId: "900",
      });

      await expect(refused).rejects.toBeInstanceOf(DifferentAccountError);
    } finally {
      close();
    }
  });
});

describe("ConnectionRegistry account participants", () => {
  it("hands the account a grant reaches to the mint, and to a later grant", async () => {
    const db = createTestDb();
    const minted: Array<{ kind: string; accountId?: string }> = [];
    const recorded: Array<{ id: string; accountId: string }> = [];
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(db.db),
      onEvent: (_tx, event) => {
        if (event.kind === "connected") {
          const { connectionKind } = event.connection;
          minted.push({ kind: connectionKind, accountId: event.account?.accountId });
        }
        if (event.kind === "fixed" && event.account) {
          recorded.push({ id: event.connection.id, accountId: event.account.accountId });
        }
      },
    });
    registry.register(botIdDescriptor());
    try {
      await registry.giveGrant(SERVICE, undefined, "bot", credentialFor("t-1"), { botId: "100" });
      const placeholder = await registry.connectAnother(SERVICE);
      await registry.giveGrant(SERVICE, placeholder.id, "bot", credentialFor("t-2"), {
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
  function recordingRegistry() {
    const db = createTestDb();
    const records = new ChannelRecordsRepository(db.db, testAccountLinkOf);
    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(db.db),
      onEvent: (tx, event) => {
        const { connection } = event;
        if (event.kind === "connected") {
          const record = event.connection;
          records.claim(tx, { ...record, account: event.account }, record.createdAt);
        }
        if (event.kind === "fixed" && event.account) {
          records.ensureAccount(tx, connection, event.account, new Date());
        }
        if (event.kind === "revoked") records.forget();
        if (event.kind === "disconnected") records.vacate(tx, connection.id);
      },
    });
    registry.register(botIdDescriptor());
    return { ...db, records, registry };
  }

  it("finds an account's Connection by the live grant that reaches it", async () => {
    const { records, registry, close } = recordingRegistry();
    try {
      const conn = await registry.giveGrant(SERVICE, undefined, "bot", credentialFor("t-1"), {
        botId: "100",
      });
      const account = records.byConnection(conn.id);
      expect(account).toMatchObject({ platformAccountId: "100", connectionId: conn.id });
      expect(records.idOf(conn.id)).toBe(account?.id);

      // A revoked grant reaches no account, so the account has no Connection.
      await registry.revoke(conn.id, "bot");
      expect(records.idOf(conn.id)).toBeNull();
      expect(records.byId(account!.id)?.connectionId).toBeNull();

      await registry.giveGrant(SERVICE, conn.id, "bot", credentialFor("t-2"), { botId: "100" });
      expect(records.idOf(conn.id)).toBe(account?.id);
      expect(records.byId(account!.id)?.connectionId).toBe(conn.id);
    } finally {
      close();
    }
  });

  it("gives a kept Connection a record again once its old account went elsewhere", async () => {
    const { records, registry, close } = recordingRegistry();
    try {
      const c1 = await registry.giveGrant(SERVICE, undefined, "bot", credentialFor("t-1"), {
        botId: "100",
      });
      await registry.revoke(c1.id, "bot");
      await registry.giveGrant(
        SERVICE,
        undefined,
        "bot",
        credentialFor("t-2"),
        { botId: "100" },
        { another: true },
      );
      expect(records.idOf(c1.id)).toBeNull();

      await registry.giveGrant(SERVICE, c1.id, "bot", credentialFor("t-3"), { botId: "300" });
      expect(records.byConnection(c1.id)).toMatchObject({
        platformAccountId: "300",
        connectionId: c1.id,
      });
      expect(records.idOf(c1.id)).not.toBeNull();
    } finally {
      close();
    }
  });

  it("records the account a Connection kept across a revoke reaches next", async () => {
    const { records, registry, close } = recordingRegistry();
    try {
      const conn = await registry.giveGrant(SERVICE, undefined, "bot", credentialFor("t-1"), {
        botId: "100",
      });
      expect(records.byConnection(conn.id)?.platformAccountId).toBe("100");

      await registry.revoke(conn.id, "bot");
      await registry.giveGrant(SERVICE, conn.id, "bot", credentialFor("t-2"), { botId: "200" });
      expect(records.byConnection(conn.id)?.platformAccountId).toBe("200");
    } finally {
      close();
    }
  });

  it("connects an account again while the Connection whose grant was revoked stays", async () => {
    const { records, registry, close } = recordingRegistry();
    try {
      const old = await registry.giveGrant(SERVICE, undefined, "bot", credentialFor("t-1"), {
        botId: "100",
      });
      await registry.revoke(old.id, "bot");

      const next = await registry.giveGrant(
        SERVICE,
        undefined,
        "bot",
        credentialFor("t-2"),
        { botId: "100" },
        { another: true },
      );
      expect(next.id).not.toBe(old.id);
      expect(records.byConnection(next.id)?.platformAccountId).toBe("100");
      // The revoked Connection backs nothing, so the kind's one link reaches
      // the new account alone.
      expect(records.byConnection(old.id)).toBeNull();
      expect(records.idOf(old.id)).toBeNull();
      expect(records.channelOfLink(SERVICE)).toBe(records.idOf(next.id));
    } finally {
      close();
    }
  });
});
