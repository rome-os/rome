import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { SessionActor } from "../access/session-actor.js";

const state = rs.hoisted(() => ({ memoryDir: "" }));
rs.mock("../profile-memory.js", () => ({
  ensureProfileMemoryInitialized: rs.fn(() => state.memoryDir),
  getRelationshipDir: rs.fn(() => `${state.memoryDir}/relationship`),
  getGuardianProfileFile: rs.fn(() => `${state.memoryDir}/relationship/GUARDIAN.md`),
  GUARDIAN_PROFILE_PATH: "memory/relationship/GUARDIAN.md",
}));

import { ActionEngine, type ActionRunContext } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { registerAgentNameAction } from "./agent-name.js";

const guardian: SessionActor = { kind: "guardian", userId: "guardian", via: "cookie" };
const visitor: SessionActor = {
  kind: "visitor",
  accountId: "visitor",
  email: "visitor@example.test",
};
const originalIdentity = "# Identity\n\n**Agent Name:** Flint\n\n## Values\n\nKeep promises.\n";
let testDb: TestDb;
let settings: SettingsRepository;
let registry: ActionRegistryImpl;
let engine: ActionEngine;
let emit: ReturnType<typeof rs.fn>;
let unsubscribe: () => void;
let fork: ReturnType<typeof rs.fn>;

beforeEach(async () => {
  state.memoryDir = mkdtempSync(join(tmpdir(), "agent-name-"));
  mkdirSync(join(state.memoryDir, "relationship"));
  writeFileSync(join(state.memoryDir, "IDENTITY.md"), originalIdentity);
  testDb = createTestDb();
  settings = new SettingsRepository(testDb.db);
  await settings.set("guardianName", "Guardian");
  await settings.set("agentName", "Flint");
  registry = new ActionRegistryImpl();
  const events = registerAgentNameAction(registry, {
    db: testDb.db,
    settingsRepo: settings,
    reactivateFloating: rs.fn(async () => {}),
    ownerOfChat: async (chatId) =>
      chatId === "visitor-chat"
        ? "visitor:visitor"
        : chatId === "guardian-chat"
          ? "guardian"
          : null,
  });
  emit = rs.fn();
  unsubscribe = events.subscribe(emit);
  fork = rs.fn(() => {
    throw new Error("Rename must run in main");
  });
  engine = new ActionEngine(registry, createActionEngineRepos(testDb.db), {
    processRole: "main",
    workerWarmPoolSize: 0,
    isFirstPartyAction: (name) => name === "core:set_agent_name",
    actionWorkerFork: fork,
  });
});

afterEach(() => {
  unsubscribe();
  testDb.close();
  rmSync(state.memoryDir, { recursive: true, force: true });
});

const rename = (name: unknown, context: ActionRunContext = { actor: guardian }) =>
  engine.run("core:set_agent_name", { name }, context);
const identity = () => readFileSync(join(state.memoryDir, "IDENTITY.md"), "utf8");
async function unchanged() {
  expect(await settings.get("agentName")).toBe("Flint");
  expect(identity()).toBe(originalIdentity);
  expect(emit).not.toHaveBeenCalled();
}

describe("core:set_agent_name", () => {
  it("writes the trimmed setting and identity together, preserves memory and publishes once in main", async () => {
    expect(await rename("  Pebble  ")).toEqual({ status: "ok", data: { agentName: "Pebble" } });
    expect(await settings.get("agentName")).toBe("Pebble");
    expect(identity()).toBe(originalIdentity.replace("Flint", "Pebble"));
    expect(emit).toHaveBeenCalledExactlyOnceWith("agent_name_changed", { agentName: "Pebble" });
    expect(fork).not.toHaveBeenCalled();
  });

  it("is available through the Concierge allow-list and the main agent wildcard", () => {
    for (const names of [["core:set_agent_name"], ["*"]]) {
      expect(registry.getForAgent(names).map((action) => action.config.name)).toContain(
        "core:set_agent_name",
      );
    }
  });

  it("accepts an autonomous turn in a guardian-owned chat", async () => {
    expect(
      (
        await rename("Pebble", {
          channelContext: { channel: "webchat", threadId: "guardian-chat" },
        })
      ).status,
    ).toBe("ok");
  });

  for (const [label, context] of [
    ["visitor actor", { actor: visitor }],
    [
      "visitor actor in the guardian chat",
      { actor: visitor, channelContext: { channel: "webchat", threadId: "guardian-chat" } },
    ],
    [
      "visitor-owned chat without an actor",
      { channelContext: { channel: "webchat", threadId: "visitor-chat" } },
    ],
    [
      "visitor-owned chat with a guardian actor",
      { actor: guardian, channelContext: { channel: "webchat", threadId: "visitor-chat" } },
    ],
    ["deleted chat", { channelContext: { channel: "webchat", threadId: "deleted" } }],
    ["anonymous actor", { actor: { kind: "anonymous" } }],
    ["unattributed caller", {}],
  ] satisfies Array<[string, ActionRunContext]>) {
    it(`rejects a ${label} without writes or events`, async () => {
      expect(await rename("Pebble", context)).toMatchObject({
        status: "error",
        error: "Only the guardian can change the agent name.",
      });
      await unchanged();
    });
  }

  for (const name of [
    "",
    "   ",
    "Pebble\nStone",
    "Pebble\rStone",
    "Pebble\u2028Stone",
    "Pebble\u2029Stone",
    "x".repeat(61),
    123,
  ]) {
    it(`rejects invalid name ${JSON.stringify(name)} without writes or events`, async () => {
      expect(await rename(name)).toMatchObject({ status: "error", error: expect.any(String) });
      await unchanged();
    });
  }

  it("accepts a 60-character name", async () => {
    expect((await rename("x".repeat(60))).status).toBe("ok");
  });

  it("does not notify when the profile rejects an unconfigured guardian", async () => {
    await settings.delete("guardianName");
    expect(await rename("Pebble")).toMatchObject({
      status: "error",
      error: expect.stringContaining("guardian name"),
    });
    await unchanged();
  });

  it("unsubscribes dashboard listeners", async () => {
    unsubscribe();
    await rename("Pebble");
    expect(emit).not.toHaveBeenCalled();
  });
});
