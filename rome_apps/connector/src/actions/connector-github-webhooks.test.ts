import type { ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { subscribeGithubWebhook, unionGithubEvents } from "./connector-github-subscribe/index.js";
import { unsubscribeGithubWebhook } from "./connector-github-unsubscribe/index.js";
import type {
  GithubHook,
  GithubHookClient,
  GithubHookMutationInput,
} from "./github-hook-client.js";

const readGithubOAuthToken = rs.fn();
rs.mock("../api/github-proxy.js", () => ({
  readGithubOAuthToken: () => readGithubOAuthToken(),
}));

const { createAction } = await import("./connector-github-subscribe/index.js");

const config: ActionConfig = {
  name: "connector_github_subscribe",
  type: "custom",
  description: "connector_github_subscribe",
  complexity: "simple",
  speed: "moderate",
  reliability: "medium",
  sideEffects: "write",
};

const RELAY_URL = "https://relay.example/h/mbox";
const LEGACY_URL = "https://acme.romeos.cc/api/app-api/connector/webhook";

function hook(id: number, url: string, events: string[] = ["push"]): GithubHook {
  return { id, events, config: { url } };
}

function makeClient(initial: GithubHook[]): GithubHookClient & {
  calls: Array<{ op: string; hookId?: number; input?: GithubHookMutationInput }>;
} {
  const hooks = [...initial];
  const calls: Array<{ op: string; hookId?: number; input?: GithubHookMutationInput }> = [];
  return {
    calls,
    async listHooks() {
      calls.push({ op: "list" });
      return hooks;
    },
    async createHook(input) {
      calls.push({ op: "create", input });
      const created = hook(100 + calls.length, input.config.url, input.events);
      hooks.push(created);
      return created;
    },
    async updateHook(hookId, input) {
      calls.push({ op: "update", hookId, input });
      const existing = hooks.find((h) => h.id === hookId);
      if (!existing) throw Object.assign(new Error("missing hook"), { status: 404 });
      existing.config = input.config;
      existing.events = input.events;
      existing.active = input.active;
      return existing;
    },
    async deleteHook(hookId) {
      calls.push({ op: "delete", hookId });
      const index = hooks.findIndex((h) => h.id === hookId);
      if (index >= 0) hooks.splice(index, 1);
    },
  };
}

beforeEach(() => {
  rs.clearAllMocks();
  rs.unstubAllEnvs();
});

describe("unionGithubEvents", () => {
  it("preserves existing events and adds requested events", () => {
    expect(unionGithubEvents(["push", "issues"], ["pull_request", "push"])).toEqual([
      "push",
      "issues",
      "pull_request",
    ]);
  });

  it("preserves GitHub wildcard semantics", () => {
    expect(unionGithubEvents(["push"], ["*"])).toEqual(["*"]);
    expect(unionGithubEvents(["*"], ["issues"])).toEqual(["*"]);
  });
});

describe("subscribeGithubWebhook", () => {
  it("creates a relay hook when no Rome-owned hook exists", async () => {
    const client = makeClient([hook(1, "https://elsewhere.example/webhook")]);

    const result = await subscribeGithubWebhook({
      client,
      relayDepositUrl: RELAY_URL,
      legacyInstanceUrl: LEGACY_URL,
      requestedEvents: ["push"],
      secret: "secret",
    });

    expect(result).toMatchObject({ created: true, migrated: false, events: ["push"] });
    expect(client.calls.map((c) => c.op)).toEqual(["list", "create"]);
    expect(client.calls[1].input?.config.url).toBe(RELAY_URL);
  });

  it("migrates an existing legacy direct hook to the relay URL", async () => {
    const client = makeClient([hook(7, LEGACY_URL, ["push"])]);

    const result = await subscribeGithubWebhook({
      client,
      relayDepositUrl: RELAY_URL,
      legacyInstanceUrl: LEGACY_URL,
      requestedEvents: ["issues"],
      secret: "secret",
    });

    expect(result).toMatchObject({
      hookId: 7,
      created: false,
      migrated: true,
      events: ["push", "issues"],
    });
    expect(client.calls.map((c) => c.op)).toEqual(["list", "update"]);
    expect(client.calls[1]).toMatchObject({ op: "update", hookId: 7 });
    expect(client.calls[1].input?.config.url).toBe(RELAY_URL);
  });

  it("reuses one relay hook and deletes duplicate relay and legacy hooks", async () => {
    const client = makeClient([
      hook(1, RELAY_URL, ["push"]),
      hook(2, RELAY_URL, ["issues"]),
      hook(3, LEGACY_URL, ["pull_request"]),
    ]);

    const result = await subscribeGithubWebhook({
      client,
      relayDepositUrl: RELAY_URL,
      legacyInstanceUrl: LEGACY_URL,
      requestedEvents: ["pull_request"],
      secret: "secret",
    });

    expect(result).toMatchObject({
      hookId: 1,
      migrated: true,
      deletedDuplicates: 2,
      events: ["push", "pull_request"],
    });
    expect(client.calls.map((c) => c.op)).toEqual(["list", "update", "delete", "delete"]);
    expect(client.calls.slice(2).map((c) => c.hookId)).toEqual([2, 3]);
  });

  it("falls back to delete-then-create for non-retryable legacy update failures", async () => {
    const client = makeClient([hook(9, LEGACY_URL, ["push"])]);
    client.updateHook = async () => {
      client.calls.push({ op: "update", hookId: 9 });
      throw Object.assign(new Error("validation failed"), { status: 422 });
    };

    const result = await subscribeGithubWebhook({
      client,
      relayDepositUrl: RELAY_URL,
      legacyInstanceUrl: LEGACY_URL,
      requestedEvents: ["issues"],
      secret: "secret",
    });

    expect(result).toMatchObject({ created: true, migrated: true, events: ["push", "issues"] });
    expect(client.calls.map((c) => c.op)).toEqual(["list", "update", "delete", "create"]);
    expect(client.calls[2]).toMatchObject({ op: "delete", hookId: 9 });
  });

  it("does not delete legacy hooks for retryable update failures", async () => {
    const client = makeClient([hook(9, LEGACY_URL, ["push"])]);
    client.updateHook = async () => {
      client.calls.push({ op: "update", hookId: 9 });
      throw Object.assign(new Error("rate limited"), { status: 403 });
    };

    await expect(
      subscribeGithubWebhook({
        client,
        relayDepositUrl: RELAY_URL,
        legacyInstanceUrl: LEGACY_URL,
        requestedEvents: ["issues"],
        secret: "secret",
      }),
    ).rejects.toThrow(/rate limited/);
    expect(client.calls.map((c) => c.op)).toEqual(["list", "update"]);
  });

  it("falls back to delete-then-create for non-retryable relay update failures", async () => {
    const client = makeClient([hook(11, RELAY_URL, ["push"])]);
    client.updateHook = async () => {
      client.calls.push({ op: "update", hookId: 11 });
      throw Object.assign(new Error("gone"), { status: 410 });
    };

    const result = await subscribeGithubWebhook({
      client,
      relayDepositUrl: RELAY_URL,
      legacyInstanceUrl: LEGACY_URL,
      requestedEvents: ["issues"],
      secret: "secret",
    });

    expect(result).toMatchObject({
      created: true,
      migrated: false,
      events: ["push", "issues"],
    });
    expect(client.calls.map((c) => c.op)).toEqual(["list", "update", "delete", "create"]);
    expect(client.calls[2]).toMatchObject({ op: "delete", hookId: 11 });
  });

  it("reports partial migration failure when create fails after fallback delete", async () => {
    const client = makeClient([hook(9, LEGACY_URL, ["push"])]);
    client.updateHook = async () => {
      client.calls.push({ op: "update", hookId: 9 });
      throw Object.assign(new Error("gone"), { status: 410 });
    };
    client.createHook = async () => {
      client.calls.push({ op: "create" });
      throw new Error("create refused");
    };

    await expect(
      subscribeGithubWebhook({
        client,
        relayDepositUrl: RELAY_URL,
        legacyInstanceUrl: LEGACY_URL,
        requestedEvents: ["issues"],
        secret: "secret",
      }),
    ).rejects.toThrow(/deleted legacy hook 9.*failed to create the relay hook/);
    expect(client.calls.map((c) => c.op)).toEqual(["list", "update", "delete", "create"]);
  });
});

describe("unsubscribeGithubWebhook", () => {
  it("deletes exact relay and legacy URL matches only", async () => {
    const client = makeClient([
      hook(1, RELAY_URL),
      hook(2, LEGACY_URL),
      hook(3, "https://other.example/webhook"),
    ]);

    const deleted = await unsubscribeGithubWebhook(client, [RELAY_URL, LEGACY_URL]);

    expect(deleted).toBe(2);
    expect(client.calls.map((c) => c.op)).toEqual(["list", "delete", "delete"]);
    expect(client.calls.slice(1).map((c) => c.hookId)).toEqual([1, 2]);
  });
});

describe("connector_github_subscribe action", () => {
  it("fails before calling GitHub when the relay mailbox is missing", async () => {
    readGithubOAuthToken.mockResolvedValueOnce("gho_token");
    const deps = {
      appContext: {
        repositories: { settings: { get: async () => null, set: async () => {} } },
      },
    } as unknown as AppActionRuntimeDeps;

    const result = await createAction(config, deps).execute({
      repo: "acme/widgets",
      events: ["push"],
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/relay mailbox/i);
    expect(result.error).toMatch(/Relay health/);
  });
});
