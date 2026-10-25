import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelRecord } from "../db/repositories/channel-records.js";
import { AccountListening, answeringAgentOf, accountAgentResolver } from "./account-agents.js";

const warn = rs.hoisted(() => rs.fn());
const info = rs.hoisted(() => rs.fn());

rs.mock("../logger.js", () => ({
  createLogger: () => ({ debug: rs.fn(), info, warn, error: rs.fn() }),
}));

describe("accountAgentResolver", () => {
  let agent: string | null;
  let loaded: Set<string>;
  let records: Map<string, { connectionKind: string; agent: string | null }>;
  const repository = {
    byId: (id: string) => {
      const record = records.get(id);
      return record ? ({ id, ...record } as unknown as ChannelRecord) : null;
    },
  };
  const agents = { has: (name: string) => loaded.has(name) };

  beforeEach(() => {
    agent = "sales:agent";
    loaded = new Set(["sales:agent", "support:agent"]);
    records = new Map();
    warn.mockClear();
    info.mockClear();
  });

  const link = (id: string, service: string) =>
    records.set(id, {
      connectionKind: service,
      get agent() {
        return agent;
      },
    });

  it("reads a linkable channel's agent from its record on each call", () => {
    link("feishu-2", "feishu");
    const accountAgentOf = accountAgentResolver(repository, agents);

    expect(accountAgentOf("feishu-2")).toBe("sales:agent");
    agent = "support:agent";
    expect(accountAgentOf("feishu-2")).toBe("support:agent");
    agent = "core:main";
    expect(accountAgentOf("feishu-2")).toBe("core:main");
    agent = null;
    expect(accountAgentOf("feishu-2")).toBeNull();
  });

  it("reads a channel whose record lands after it was built", () => {
    const accountAgentOf = accountAgentResolver(repository, agents);

    expect(accountAgentOf("c-7f3a")).toBeUndefined();
    link("c-7f3a", "telegram");
    expect(accountAgentOf("c-7f3a")).toBe("sales:agent");
  });

  it("reads null for a linkable channel no record names", () => {
    expect(accountAgentResolver(repository, agents)("telegram")).toBeNull();
  });

  it("logs an account with no agent once, until it is linked", () => {
    link("feishu-2", "feishu");
    agent = null;
    const accountAgentOf = accountAgentResolver(repository, agents);

    expect(accountAgentOf("feishu-2")).toBeNull();
    expect(accountAgentOf("feishu-2")).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.any(String), { channel: "feishu-2" });

    agent = "sales:agent";
    expect(accountAgentOf("feishu-2")).toBe("sales:agent");
    agent = null;
    expect(accountAgentOf("feishu-2")).toBeNull();
    expect(info).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads null while the account's agent is not loaded, and warns once until it loads", () => {
    link("feishu-2", "feishu");
    const accountAgentOf = accountAgentResolver(repository, agents);
    loaded.delete("sales:agent");

    expect(accountAgentOf("feishu-2")).toBeNull();
    expect(accountAgentOf("feishu-2")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      channel: "feishu-2",
      agent: "sales:agent",
    });

    loaded.add("sales:agent");
    expect(accountAgentOf("feishu-2")).toBe("sales:agent");
    loaded.delete("sales:agent");
    expect(accountAgentOf("feishu-2")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("reads undefined for a channel of a service that takes no link", () => {
    const accountAgentOf = accountAgentResolver(repository, agents);

    for (const name of ["webchat", "email", "agents", "whatsapp"]) {
      expect(accountAgentOf(name)).toBeUndefined();
    }
  });
});

describe("AccountListening", () => {
  const records = new Map<string, { connectionKind: string; agent: string | null }>();
  const repository = {
    byId: (id: string) => {
      const record = records.get(id);
      return record ? ({ id, ...record } as unknown as ChannelRecord) : null;
    },
  };

  beforeEach(() => records.clear());

  it("listens to a linkable account only while its record names an agent", () => {
    const listening = new AccountListening(repository);
    records.set("feishu-2", { connectionKind: "feishu", agent: "sales:agent" });
    expect(listening.listens("feishu-2")).toBe(true);

    records.set("feishu-2", { connectionKind: "feishu", agent: null });
    expect(listening.listens("feishu-2")).toBe(false);

    // An agent that is not loaded still holds the account.
    records.set("feishu-2", { connectionKind: "feishu", agent: "gone:agent" });
    expect(listening.listens("feishu-2")).toBe(true);
  });

  it("tells every listener of a change even when one throws", () => {
    const listening = new AccountListening(repository);
    const heard = rs.fn();
    listening.onChange(() => {
      throw new Error("port failed");
    });
    listening.onChange(heard);
    warn.mockClear();

    listening.changed(["feishu-2", null]);

    expect(heard).toHaveBeenCalledWith("feishu-2");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not listen to a linkable channel no record names", () => {
    expect(new AccountListening(repository).listens("telegram")).toBe(false);
  });

  it("always listens to an account of a service that takes no agent", () => {
    const listening = new AccountListening(repository);
    records.set("email", { connectionKind: "email", agent: null });

    for (const name of ["email", "webchat", "agents", "whatsapp"]) {
      expect(listening.listens(name)).toBe(true);
    }
  });

  it("tells every listener of each account a write touched", () => {
    const listening = new AccountListening(repository);
    const heard: string[][] = [[], []];
    listening.onChange((channel) => heard[0]!.push(channel));
    listening.onChange((channel) => heard[1]!.push(channel));

    listening.changed(["telegram", null, "telegram_user"]);

    expect(heard).toEqual([
      ["telegram", "telegram_user"],
      ["telegram", "telegram_user"],
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
