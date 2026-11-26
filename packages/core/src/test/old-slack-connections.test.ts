// A Connection of a Slack kind Rome no longer offers stays in the store, with
// its grant, channel record and connected account, as the personal WeChat
// removal left its own. The registry skips a stored Connection whose kind is not
// registered, and every other surface reads Connections through the registry,
// so such a row is ignored everywhere: boot passes it, nothing lists, starts,
// renews or sends through it, and Slack counts as connected only through
// Rome's Slack app. Built in test/ because it crosses the store, the registry,
// the connections route and the channels service.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatId } from "@rome-os/app-runtime";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { listConnectionViews } from "../api/routes/connections.js";
import { createChannelsService } from "../app-host/accounts-service.js";
import { romeAccounts } from "../chats/connected-accounts/rome-accounts.js";
import { recordGrantAccounts } from "../connections/grant-accounts.js";
import { runningSendersOn } from "../connections/send.js";
import {
  type BuiltinConnectionDeps,
  registerBuiltinConnections,
} from "../connections/integrations/index.js";
import { ConnectionRegistry } from "../connections/registry.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import { removeUnconnectedAccounts } from "../connections/unconnected-accounts.js";
import { accountLinkOf } from "../chats/connected-accounts/account-links.js";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import type { Logger } from "../logger.js";
import { createTestDbFile, type TestDb } from "./db.js";

/** The old Slack kinds, each with the account its stored grant reached. The
 *  Slack bot was a chat connection, with a channel and a connected account;
 *  the Slack sign-in acted for the guardian and had neither. */
const OLD = [
  { id: "conn-old-slack-bot", kind: "slack_bot", account: "U_OLD_BOT", chats: true },
  { id: "conn-old-slack-sign-in", kind: "slack", account: "U_GUARDIAN", chats: false },
];

const NOW = Math.floor(Date.now() / 1000);

/** A stored Connection of `kind`, as Rome left it while it offered the kind:
 *  its live grant holding a token and, for a chat connection, its channel
 *  record and its connected account. */
function storeOld(sqlite: Database.Database, old: (typeof OLD)[number]): void {
  const { id, kind, account: accountId } = old;
  sqlite
    .prepare("INSERT INTO connections (id, connection_kind, label, created_at) VALUES (?, ?, ?, ?)")
    .run(id, kind, kind, NOW);
  sqlite
    .prepare(
      `INSERT INTO connection_grants (custody, state, credential, platform, account_id)
       VALUES (?, 'authorized', ?, 'slack', ?)`,
    )
    .run(
      id,
      JSON.stringify({ material: { token: `xox-of-${id}` }, expiresAt: "never" }),
      accountId,
    );
  if (!old.chats) return;
  sqlite
    .prepare(
      `INSERT INTO channels (id, connection_kind, platform, connection_id, platform_account_id, created_at)
       VALUES (?, ?, 'slack', ?, ?, ?)`,
    )
    .run(`channel-${id}`, kind, id, accountId, NOW);
  sqlite
    .prepare(
      "INSERT INTO connected_accounts (platform, account_id, agent) VALUES ('slack', ?, 'main')",
    )
    .run(accountId);
}

function count(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const opened: Array<() => void> = [];
afterEach(() => {
  while (opened.length) opened.pop()?.();
  rs.unstubAllGlobals();
});

/** A store holding every old Slack Connection, and a registry over it with
 *  every kind boot registers, loaded as boot loads it. */
async function bootOverOldRows(also?: (sqlite: Database.Database) => void) {
  const dir = mkdtempSync(join(tmpdir(), "old-slack-"));
  const open = createTestDbFile(join(dir, "rome.db"));
  const store: TestDb & { sqlite: Database.Database } = open();
  opened.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const old of OLD) storeOld(store.sqlite, old);
  also?.(store.sqlite);

  const logger = { warn: rs.fn(), error: rs.fn(), info() {}, debug() {} };
  const repository = new DrizzleConnectionsRepository(store.db);
  const registry = new ConnectionRegistry({ repository, logger: logger as unknown as Logger });
  registerBuiltinConnections(registry, {
    listAgents: () => [],
    slackApp: {
      api: {},
      cloud: {},
      openMailbox: () => ({ stop() {}, attempts: 4 }),
      listens: () => true,
    },
  } as unknown as BuiltinConnectionDeps);
  await registry.load({ deferCapabilities: true });
  return { store, logger, repository, registry };
}

describe("a stored Connection of an old Slack kind", () => {
  it("is skipped at boot with a warning, never an error, and stays in the store", async () => {
    const { store, logger, registry } = await bootOverOldRows();
    // The boot passes that walk the Connections run past it.
    await expect(removeUnconnectedAccounts(registry)).resolves.toEqual([]);
    await recordGrantAccounts(registry);
    registry.startCapabilities();

    for (const old of OLD) {
      expect(logger.warn).toHaveBeenCalledWith(
        "Skipping connection for unregistered connectionKind",
        { connectionId: old.id, connectionKind: old.kind },
      );
      expect(registry.isRegistered(old.kind)).toBe(false);
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(registry.all()).toEqual([]);
    for (const table of ["connections", "connection_grants"]) {
      expect(count(store.sqlite, table)).toBe(OLD.length);
    }
    for (const table of ["channels", "connected_accounts"]) {
      expect(count(store.sqlite, table)).toBe(OLD.filter((old) => old.chats).length);
    }
  });

  it("is neither listed nor offered to connect, and Slack is offered only as Rome's Slack app", async () => {
    const { store, registry } = await bootOverOldRows();
    const views = await listConnectionViews({ connectionRegistry: registry, db: store.db });
    const kinds = views.map((view) => view.connectionKind);
    for (const old of OLD) expect(kinds).not.toContain(old.kind);
    expect(views.filter((view) => view.id !== undefined && view.id !== null)).toEqual([]);
    expect(views.find((view) => view.connectionKind === "slack_app")).toMatchObject({
      connectionKind: "slack_app",
    });
    // A lookup by the Slack platform, as the Concierge and the connector make,
    // finds no Connection on Slack, so Slack does not count as connected.
    for (const old of OLD) {
      await expect(
        listConnectionViews(
          { connectionRegistry: registry, db: store.db },
          { platform: "slack", accountId: old.account },
        ),
      ).resolves.toEqual([]);
    }
    await expect(
      listConnectionViews({ connectionRegistry: registry, db: store.db }, { platform: "slack" }),
    ).resolves.toEqual([]);
  });

  it("starts no talker and renews no token", async () => {
    const fetchMock = rs.fn(async () => new Response("{}", { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);
    const { registry } = await bootOverOldRows();
    registry.startCapabilities();
    await registry.renewExpiring(Number.MAX_SAFE_INTEGER);

    for (const old of OLD) expect(registry.find(old.kind)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives apps no Slack channel and refuses to send as its account", async () => {
    const { registry, repository } = await bootOverOldRows();
    const channels = createChannelsService({
      channels: () => undefined,
      registry,
      channelOf: (connection) => connection.connectionKind,
      accounts: romeAccounts(repository),
    });

    // The connector takes the channel on the Slack platform as Rome's Slack
    // app (`slackAppConnection`), so finding none keeps Slack unconnected.
    const listed = await channels.list();
    expect(listed.filter((summary) => summary.platform === "slack")).toEqual([]);
    for (const old of OLD) {
      await expect(
        channels.send({ platform: "slack", id: old.account }, "D_ANY" as ChatId, { text: "hi" }),
      ).rejects.toThrow();
    }
  });

  it("is no sender beside Rome's Slack app, so a send that names none goes out from the app", async () => {
    const { store, registry } = await bootOverOldRows((sqlite) =>
      storeOld(sqlite, {
        id: "conn-slack-app",
        kind: "slack_app",
        account: "T_A/U_APP",
        chats: true,
      }),
    );
    expect(registry.all().map((connection) => connection.connectionKind)).toEqual(["slack_app"]);
    const records = new ChannelRecordsRepository(store.db, accountLinkOf(registry));
    // The store alone still reaches the old channel through its kept grant.
    expect(records.sendersOn("slack")).toHaveLength(OLD.filter((old) => old.chats).length + 1);
    expect(runningSendersOn(records, registry)("slack")).toEqual(["channel-conn-slack-app"]);
  });
});
