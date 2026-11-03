import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { NO_GRANT } from "../connections/grant.js";
import { DrizzleConnectionsRepository } from "../connections/repository-db.js";
import type { ChannelRecord } from "../db/repositories/channel-records.js";
import {
  ConnectedAccountNotFound,
  ConnectedAccountsRepository,
} from "../db/repositories/connected-accounts.js";
import { createTestDb, type TestDb, testAccountLinkOf } from "../test/helpers.js";
import {
  AccountListening,
  AccountNotLinkable,
  answeringAgentOf,
  accountAgentResolver,
  byChannel,
  linkAccountAgent,
  type AccountAgents,
} from "./account-agents.js";

const warn = rs.hoisted(() => rs.fn());
const info = rs.hoisted(() => rs.fn());

rs.mock("../logger.js", () => ({
  createLogger: () => ({ debug: rs.fn(), info, warn, error: rs.fn() }),
}));

/** The connections Rome holds, each with its kind and its connected account's
 *  agent. */
type Held = Map<string, { connectionKind: string; agent: string | null }>;

function accountAgents(held: () => Held): AccountAgents {
  return {
    kindOf: (id) => held().get(id)?.connectionKind ?? null,
    linkOf: testAccountLinkOf,
    accounts: { agentOf: (connectionId) => held().get(connectionId)?.agent ?? null },
  };
}

describe("accountAgentResolver", () => {
  let agent: string | null;
  let loaded: Set<string>;
  let held: Held;
  const sources = accountAgents(() => held);
  const agents = { has: (name: string) => loaded.has(name) };

  beforeEach(() => {
    agent = "sales:agent";
    loaded = new Set(["sales:agent", "support:agent"]);
    held = new Map();
    warn.mockClear();
    info.mockClear();
  });

  const connect = (id: string, connectionKind: string) =>
    held.set(id, {
      connectionKind,
      get agent() {
        return agent;
      },
    });

  it("reads a linkable account's agent on each call", () => {
    connect("c-feishu-2", "feishu");
    const accountAgentOf = accountAgentResolver(sources, agents);

    expect(accountAgentOf("c-feishu-2")).toBe("sales:agent");
    agent = "support:agent";
    expect(accountAgentOf("c-feishu-2")).toBe("support:agent");
    agent = "core:main";
    expect(accountAgentOf("c-feishu-2")).toBe("core:main");
    agent = null;
    expect(accountAgentOf("c-feishu-2")).toBeNull();
  });

  it("reads a connection Rome comes to hold after it was built", () => {
    const accountAgentOf = accountAgentResolver(sources, agents);

    expect(accountAgentOf("c-7f3a")).toBeUndefined();
    connect("c-7f3a", "telegram");
    expect(accountAgentOf("c-7f3a")).toBe("sales:agent");
  });

  it("logs an account with no agent once, until it is linked", () => {
    connect("c-feishu-2", "feishu");
    agent = null;
    const accountAgentOf = accountAgentResolver(sources, agents);

    expect(accountAgentOf("c-feishu-2")).toBeNull();
    expect(accountAgentOf("c-feishu-2")).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.any(String), { connectionId: "c-feishu-2" });

    agent = "sales:agent";
    expect(accountAgentOf("c-feishu-2")).toBe("sales:agent");
    agent = null;
    expect(accountAgentOf("c-feishu-2")).toBeNull();
    expect(info).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads null while the account's agent is not loaded, and warns once until it loads", () => {
    connect("c-feishu-2", "feishu");
    const accountAgentOf = accountAgentResolver(sources, agents);
    loaded.delete("sales:agent");

    expect(accountAgentOf("c-feishu-2")).toBeNull();
    expect(accountAgentOf("c-feishu-2")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      connectionId: "c-feishu-2",
      agent: "sales:agent",
    });

    loaded.add("sales:agent");
    expect(accountAgentOf("c-feishu-2")).toBe("sales:agent");
    loaded.delete("sales:agent");
    expect(accountAgentOf("c-feishu-2")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reads undefined for an account whose kind of connection takes no agent", () => {
    for (const kind of ["email", "agents", "whatsapp"]) connect(`c-${kind}`, kind);
    const accountAgentOf = accountAgentResolver(sources, agents);

    for (const id of ["c-email", "c-agents", "c-whatsapp", "c-unheld"]) {
      expect(accountAgentOf(id)).toBeUndefined();
    }
  });
});

describe("byChannel", () => {
  const recorded: Record<string, Pick<ChannelRecord, "connectionKind" | "connectionId">> = {
    "feishu-2": { connectionKind: "feishu", connectionId: "c-feishu-2" },
    released: { connectionKind: "telegram", connectionId: null },
  };
  const records = {
    byId: (id: string) => (recorded[id] ? ({ id, ...recorded[id] } as ChannelRecord) : null),
    linkOf: testAccountLinkOf,
  };
  const agentOf = byChannel(records, (connectionId) => `agent of ${connectionId}`);

  it("answers for the connection that backs the channel", () => {
    expect(agentOf("feishu-2")).toBe("agent of c-feishu-2");
  });

  it("answers null for a linkable channel no connection backs", () => {
    expect(agentOf("released")).toBeNull();
    expect(agentOf("telegram")).toBeNull();
  });

  it("answers undefined for a channel whose kind takes no agent", () => {
    for (const name of ["webchat", "email", "agents", "whatsapp"]) {
      expect(agentOf(name)).toBeUndefined();
    }
  });
});

describe("AccountListening", () => {
  const held: Held = new Map();
  const sources = accountAgents(() => held);

  beforeEach(() => held.clear());

  it("listens to a linkable account only while its connected account names an agent", () => {
    const listening = new AccountListening(sources);
    held.set("c-feishu-2", { connectionKind: "feishu", agent: "sales:agent" });
    expect(listening.listens("c-feishu-2")).toBe(true);

    held.set("c-feishu-2", { connectionKind: "feishu", agent: null });
    expect(listening.listens("c-feishu-2")).toBe(false);

    // An agent that is not loaded still holds the account.
    held.set("c-feishu-2", { connectionKind: "feishu", agent: "gone:agent" });
    expect(listening.listens("c-feishu-2")).toBe(true);
  });

  it("tells every listener of a change even when one throws", () => {
    const listening = new AccountListening(sources);
    const heard = rs.fn();
    listening.onChange(() => {
      throw new Error("port failed");
    });
    listening.onChange(heard);
    warn.mockClear();

    listening.changed(["c-feishu-2"]);

    expect(heard).toHaveBeenCalledWith("c-feishu-2");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("always listens to an account whose kind of connection takes no agent", () => {
    const listening = new AccountListening(sources);
    for (const kind of ["email", "agents", "whatsapp"]) {
      held.set(`c-${kind}`, { connectionKind: kind, agent: null });
    }

    for (const id of ["c-email", "c-agents", "c-whatsapp"]) {
      expect(listening.listens(id)).toBe(true);
    }
  });

  it("tells every listener of each connection a write touched", () => {
    const listening = new AccountListening(sources);
    const heard: string[][] = [[], []];
    listening.onChange((connectionId) => heard[0]!.push(connectionId));
    listening.onChange((connectionId) => heard[1]!.push(connectionId));

    listening.changed(["c-telegram", "c-telegram-user"]);

    expect(heard).toEqual([
      ["c-telegram", "c-telegram-user"],
      ["c-telegram", "c-telegram-user"],
    ]);
  });
});

describe("answeringAgentOf", () => {
  it.each([
    ["a group's non-main choice", "sales:agent", "support:agent", "group", "support:agent"],
    ["a group pinned to main", "sales:agent", "main", "group", "main"],
    ["a private chat with a choice", "sales:agent", "support:agent", "private", "sales:agent"],
    ["no choice", "core:main", undefined, "group", "main"],
    ["no agent", null, "support:agent", "group", null],
    ["a service that takes no link", undefined, undefined, "private", "main"],
  ] as const)("answers %s", (_case, linked, choice, threadType, expected) => {
    expect(answeringAgentOf(linked, choice, threadType)).toBe(expected);
  });

  it("answers the account's agent in place of a choice that is not loaded", () => {
    const isLoaded = (agent: string) => agent === "support:agent";
    expect(answeringAgentOf("sales:agent", "gone:agent", "group", isLoaded)).toBe("sales:agent");
    expect(answeringAgentOf("sales:agent", "support:agent", "group", isLoaded)).toBe(
      "support:agent",
    );
    expect(answeringAgentOf("sales:agent", "main", "group", isLoaded)).toBe("main");
    expect(answeringAgentOf(undefined, "gone:agent", "group", isLoaded)).toBe("gone:agent");
  });
});

describe("linkAccountAgent", () => {
  const NOW = new Date("2026-10-26T00:00:00.000Z");
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
    testDb = undefined;
  });

  function setup() {
    testDb = createTestDb();
    const db = testDb.db;
    const accounts = new ConnectedAccountsRepository(db);
    const ledger = new DrizzleConnectionsRepository(db);
    const kinds = new Map<string, string>();
    const connect = (id: string, connectionKind: string) => {
      ledger.save(db, {
        id,
        connectionKind,
        label: connectionKind,
        createdAt: NOW,
        grant: NO_GRANT,
      });
      accounts.add(db, id);
      kinds.set(id, connectionKind);
    };
    const link = (id: string, agent: string | null) =>
      linkAccountAgent((c) => kinds.get(c) ?? null, testAccountLinkOf, accounts, id, agent);
    return { accounts, connect, link };
  }

  it("stores the link on the connected account and changes no other", () => {
    const { accounts, connect, link } = setup();
    connect("c1", "feishu");
    connect("c2", "telegram_user");

    expect(link("c2", "sales:agent")).toEqual({
      connectionId: "c2",
      agent: "sales:agent",
      link: "delegate",
    });
    expect(accounts.agentOf("c1")).toBeNull();
    expect(link("c1", "main")).toMatchObject({ agent: "core:main", link: "own_account" });
  });

  it("refuses a link to a connection Rome does not hold", () => {
    const { link } = setup();

    expect(() => link("nope", "sales:agent")).toThrow(ConnectedAccountNotFound);
    expect(() => link("nope", null)).toThrow(ConnectedAccountNotFound);
  });

  it("refuses a link to an account whose kind of connection takes none, and unlinks it", () => {
    const { connect, link } = setup();
    connect("c1", "agents");

    expect(() => link("c1", "sales:agent")).toThrow(AccountNotLinkable);
    expect(link("c1", null)).toEqual({ connectionId: "c1", agent: null, link: null });
  });
});
