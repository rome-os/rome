import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelRecord } from "../../db/repositories/channel-records.js";
import { buildAgent, testAccountLinkOf } from "../../test/helpers.js";
import {
  AccountListening,
  answeringAgentOf,
  accountAgentResolver,
  byChannel,
  type AccountAgents,
} from "./account-agents.js";

const warn = rs.hoisted(() => rs.fn());

rs.mock("../../logger.js", () => ({
  createLogger: () => ({ debug: rs.fn(), info: rs.fn(), warn, error: rs.fn() }),
}));

describe("accountAgentResolver", () => {
  let loaded: Set<string>;
  let held: Map<string, string>;
  // Feishu answers as the sales agent, and every other kind that takes an
  // agent as main.
  const sources: AccountAgents = {
    kindOf: (id) => held.get(id) ?? null,
    agentOfKind: (kind) =>
      testAccountLinkOf(kind) === null ? null : kind === "feishu" ? "sales:agent" : "core:main",
  };
  const agents = { find: (name: string) => (loaded.has(name) ? buildAgent(name) : undefined) };

  beforeEach(() => {
    loaded = new Set(["sales:agent"]);
    held = new Map();
    warn.mockClear();
  });

  it("answers each account with its kind's agent", () => {
    held.set("c-feishu-2", "feishu");
    held.set("c-telegram", "telegram");
    const accountAgentOf = accountAgentResolver(sources, agents);

    expect(accountAgentOf("c-feishu-2")).toBe("sales:agent");
    expect(accountAgentOf("c-telegram")).toBe("core:main");
  });

  it("reads a connection Rome comes to hold after it was built", () => {
    const accountAgentOf = accountAgentResolver(sources, agents);

    expect(accountAgentOf("c-7f3a")).toBeUndefined();
    held.set("c-7f3a", "telegram");
    expect(accountAgentOf("c-7f3a")).toBe("core:main");
  });

  it("reads null while the kind's agent is not loaded, and warns once until it loads", () => {
    held.set("c-feishu-2", "feishu");
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
    for (const kind of ["email", "agents", "whatsapp"]) held.set(`c-${kind}`, kind);
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
  it("listens to every account", () => {
    const listening = new AccountListening();
    for (const id of ["c-feishu-2", "c-telegram-user", "c-email"]) {
      expect(listening.listens(id)).toBe(true);
    }
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
