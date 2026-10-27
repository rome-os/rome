import { afterEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { NO_GRANT } from "../../connections/grant.js";
import { DrizzleConnectionsRepository } from "../../connections/repository-db.js";
import { connections } from "../schema.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ConnectedAccountNotFound, ConnectedAccountsRepository } from "./connected-accounts.js";

const NOW = new Date("2026-10-26T00:00:00.000Z");

describe("ConnectedAccountsRepository", () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup() {
    testDb = createTestDb();
    const db = testDb.db;
    const ledger = new DrizzleConnectionsRepository(db);
    const accounts = new ConnectedAccountsRepository(db);
    const connect = (id: string, connectionKind = "telegram") =>
      ledger.save(db, {
        id,
        connectionKind,
        label: connectionKind,
        createdAt: NOW,
        grant: NO_GRANT,
      });
    return { db, accounts, connect };
  }

  it("starts a connected account with no agent", () => {
    const { db, accounts, connect } = setup();
    connect("c1");

    accounts.add(db, "c1");

    expect(accounts.agentOf("c1")).toBeNull();
  });

  it("keeps the agent of a connected account made again", () => {
    const { db, accounts, connect } = setup();
    connect("c1");
    accounts.add(db, "c1");
    accounts.link("c1", "sales:agent");

    accounts.add(db, "c1");

    expect(accounts.agentOf("c1")).toBe("sales:agent");
  });

  it("links, switches and unlinks one account's agent and leaves the others", () => {
    const { db, accounts, connect } = setup();
    for (const id of ["c1", "c2", "c3"]) {
      connect(id);
      accounts.add(db, id);
    }
    accounts.link("c1", "sales:agent");
    accounts.link("c2", "sales:agent");
    accounts.link("c3", "support:agent");

    expect(accounts.link("c1", "support:agent")).toBe("support:agent");
    expect(accounts.link("c2", null)).toBeNull();

    expect(accounts.agentOf("c1")).toBe("support:agent");
    expect(accounts.agentOf("c2")).toBeNull();
    expect(accounts.agentOf("c3")).toBe("support:agent");
  });

  it("stores main by its canonical id", () => {
    const { db, accounts, connect } = setup();
    connect("c1");
    accounts.add(db, "c1");

    expect(accounts.link("c1", "main")).toBe("core:main");
    expect(accounts.agentOf("c1")).toBe("core:main");
  });

  it("links a connection Rome holds that has no connected account recorded", () => {
    const { accounts, connect } = setup();
    connect("c1");

    accounts.link("c1", "sales:agent");

    expect(accounts.agentOf("c1")).toBe("sales:agent");
  });

  it("refuses a link to a connection Rome does not hold, and records nothing", () => {
    const { accounts } = setup();

    expect(() => accounts.link("gone", "sales:agent")).toThrow(ConnectedAccountNotFound);
    expect(accounts.agentOf("gone")).toBeNull();
  });

  it("goes when its connection is disconnected", () => {
    const { db, accounts, connect } = setup();
    connect("c1");
    accounts.add(db, "c1");
    accounts.link("c1", "sales:agent");

    accounts.remove(db, "c1");

    expect(accounts.agentOf("c1")).toBeNull();
  });

  it("leaves no agent behind on a connection that is gone, even when nothing removes it", () => {
    const { db, accounts, connect } = setup();
    connect("c1");
    accounts.add(db, "c1");
    accounts.link("c1", "sales:agent");

    db.delete(connections).where(eq(connections.id, "c1")).run();
    connect("c1");

    expect(accounts.agentOf("c1")).toBeNull();
  });
});
