import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Permissions } from "../access/permissions.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { ActionEngine, type ActionRunContext } from "./actions/engine.js";
import { ActionRegistryImpl } from "./actions/registry.js";
import { APP_ACCESS_ACTIONS, registerAppAccessActions } from "./app-access-actions.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import {
  APP_PERMISSIONS_SETTING_KEY,
  loadAppPermissions,
  loadAppPermissionsSetting,
  type AppPermissionsSetting,
} from "./app-permissions.js";

type Actor = NonNullable<ActionRunContext["actor"]>;

const guardian: Actor = { kind: "guardian", userId: "guardian", via: "cookie" };
const visitor: Actor = { kind: "visitor", accountId: "visitor", email: "visitor@example.test" };
const APPS: Record<string, boolean> = { notes: true, "@ray/demo": true, worker: false };

let testDb: TestDb;
let permissions: Permissions;
let registry: ActionRegistryImpl;
let engine: ActionEngine;
let approvals: ReturnType<typeof createActionEngineRepos>["approvals"];
let fork: ReturnType<typeof rs.fn>;

beforeEach(async () => {
  testDb = createTestDb();
  permissions = new Permissions();
  registry = new ActionRegistryImpl();
  registerAppAccessActions(registry, {
    db: testDb.db,
    permissions,
    apps: { hasPage: (appId) => APPS[appId] ?? null },
    ownerOfChat: async (chatId) => (chatId === "visitor-chat" ? "visitor:visitor" : "guardian"),
  });
  const repos = createActionEngineRepos(testDb.db);
  approvals = repos.approvals;
  fork = rs.fn(() => {
    throw new Error("App access actions must run in main");
  });
  engine = new ActionEngine(registry, repos, {
    processRole: "main",
    workerWarmPoolSize: 0,
    isFirstPartyAction: (name) => name.startsWith("core:"),
    actionWorkerFork: fork,
  });
  await seed({
    allowedApps: [],
    cloudEmailAccess: { notes: ["a@example.test"], other: ["z@example.test"] },
  });
});

afterEach(() => {
  testDb.close();
});

async function seed(setting: AppPermissionsSetting): Promise<void> {
  await new SettingsRepository(testDb.db).set(APP_PERMISSIONS_SETTING_KEY, setting);
  await loadAppPermissions(testDb.db, permissions);
}

const run = (name: string, args: Record<string, unknown>, context: ActionRunContext = {}) =>
  engine.run(name, args, { actor: guardian, ...context });

describe("core:apps_access_read", () => {
  it("reads one app's access in main", async () => {
    expect(await run(APP_ACCESS_ACTIONS.read, { appId: "notes" })).toEqual({
      status: "ok",
      data: { appId: "notes", mode: "cloud-email", emails: ["a@example.test"] },
    });
    expect(await run(APP_ACCESS_ACTIONS.read, { appId: "@ray/demo" })).toEqual({
      status: "ok",
      data: { appId: "@ray/demo", mode: "private", emails: [] },
    });
    expect(fork).not.toHaveBeenCalled();
  });

  it("refuses an app that is not installed", async () => {
    expect(await run(APP_ACCESS_ACTIONS.read, { appId: "missing" })).toEqual({
      status: "error",
      error: 'No installed app "missing".',
    });
  });

  it("reaches agents through the wildcard", () => {
    const names = registry.getForAgent(["*"]).map((action) => action.config.name);
    expect(names).toEqual(expect.arrayContaining(Object.values(APP_ACCESS_ACTIONS)));
  });
});

describe("core:apps_access_narrow", () => {
  it("removes an email at once and leaves other apps alone", async () => {
    await seed({
      allowedApps: [],
      cloudEmailAccess: { notes: ["a@example.test", "b@example.test"], other: ["z@example.test"] },
    });
    const result = await run(APP_ACCESS_ACTIONS.narrow, {
      appId: "notes",
      mode: "cloud-email",
      emails: ["B@example.test"],
    });
    expect(result).toEqual({
      status: "ok",
      data: {
        appId: "notes",
        before: { mode: "cloud-email", emails: ["a@example.test", "b@example.test"] },
        after: { mode: "cloud-email", emails: ["b@example.test"] },
      },
    });
    expect(await loadAppPermissionsSetting(testDb.db)).toEqual({
      allowedApps: [],
      cloudEmailAccess: { notes: ["b@example.test"], other: ["z@example.test"] },
    });
    expect(permissions.get("notes").listedEmails).toEqual(new Set(["b@example.test"]));
  });

  it("refuses a change that lets anyone new in", async () => {
    for (const args of [
      { appId: "notes", mode: "public" },
      { appId: "notes", mode: "cloud-email", emails: ["c@example.test"] },
    ]) {
      const result = await run(APP_ACCESS_ACTIONS.narrow, args);
      expect(result.status).toBe("error");
      expect(result.status === "error" && result.error).toContain(APP_ACCESS_ACTIONS.update);
    }
    expect((await loadAppPermissionsSetting(testDb.db)).cloudEmailAccess.notes).toEqual([
      "a@example.test",
    ]);
  });

  it("makes an app private even when it is not installed or has no page", async () => {
    expect((await run(APP_ACCESS_ACTIONS.narrow, { appId: "other", mode: "private" })).status).toBe(
      "ok",
    );
    expect(permissions.get("other").listedEmails.size).toBe(0);
    expect(
      (await run(APP_ACCESS_ACTIONS.narrow, { appId: "worker", mode: "private" })).status,
    ).toBe("ok");
  });

  it("checks widening against the access the write starts from", async () => {
    await seed({ allowedApps: ["notes"], cloudEmailAccess: {} });
    const [toPrivate, toList] = await Promise.all([
      run(APP_ACCESS_ACTIONS.narrow, { appId: "notes", mode: "private" }),
      run(APP_ACCESS_ACTIONS.narrow, {
        appId: "notes",
        mode: "cloud-email",
        emails: ["a@example.test"],
      }),
    ]);
    expect(toPrivate.status).toBe("ok");
    expect(toList.status).toBe("error");
    expect(await loadAppPermissionsSetting(testDb.db)).toEqual({
      allowedApps: [],
      cloudEmailAccess: {},
    });
  });

  it("refuses an app with no page, and a bad email", async () => {
    expect(
      await run(APP_ACCESS_ACTIONS.narrow, {
        appId: "worker",
        mode: "cloud-email",
        emails: ["a@example.test"],
      }),
    ).toEqual({
      status: "error",
      error: 'App "worker" has no page, so it cannot be shared.',
    });
    expect(
      await run(APP_ACCESS_ACTIONS.narrow, {
        appId: "notes",
        mode: "cloud-email",
        emails: ["not an email"],
      }),
    ).toEqual({ status: "error", error: "Not an email: not an email." });
  });
});

describe("core:apps_access_update", () => {
  it("waits for the guardian's approval, then makes the change", async () => {
    const recorded = await run(APP_ACCESS_ACTIONS.update, { appId: "@ray/demo", mode: "public" });
    if (recorded.status !== "pending_approval") throw new Error(`got ${recorded.status}`);
    expect(permissions.get("@ray/demo").anyoneWithLink).toBe(false);

    const row = await approvals.findById(recorded.approval.approvalId);
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.preview).toEqual({
      kind: "generic",
      title: "Change who may open @ray/demo",
      summary: "From only the guardian to anyone with the link.",
      fields: [
        { label: "App", value: "@ray/demo" },
        { label: "Now", value: "only the guardian" },
        { label: "After", value: "anyone with the link" },
      ],
    });

    const approved = await engine.run(APP_ACCESS_ACTIONS.update, payload.rootArgs as never, {
      actor: guardian,
      replayJournal: payload.replayJournal as never,
      replayRootExecutionId: payload.rootExecutionId as string,
    });
    expect(approved.status).toBe("ok");
    expect(permissions.get("@ray/demo").anyoneWithLink).toBe(true);
    expect((await loadAppPermissionsSetting(testDb.db)).allowedApps).toEqual(["@ray/demo"]);
  });

  it("shows a visitor's request nothing about the app, and approving it changes nothing", async () => {
    const recorded = await engine.run(
      APP_ACCESS_ACTIONS.update,
      { appId: "notes", mode: "public" },
      { actor: visitor },
    );
    if (recorded.status !== "pending_approval") throw new Error(`got ${recorded.status}`);
    const payload = (await approvals.findById(recorded.approval.approvalId))!.payload as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(payload.preview)).not.toContain("a@example.test");
    expect(payload.preview).toMatchObject({ title: "Request not from the guardian" });

    const approved = await engine.run(APP_ACCESS_ACTIONS.update, payload.rootArgs as never, {
      actor: visitor,
      replayJournal: payload.replayJournal as never,
      replayRootExecutionId: payload.rootExecutionId as string,
    });
    expect(approved).toEqual({ status: "error", error: "Only the guardian can do this." });
    expect(permissions.get("notes").anyoneWithLink).toBe(false);
  });
});

describe("who may ask", () => {
  for (const [label, context] of [
    ["a visitor", { actor: visitor }],
    [
      "a turn in a visitor's chat",
      { channelContext: { channel: "webchat", threadId: "visitor-chat" } },
    ],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const ctx: ActionRunContext = "actor" in context ? context : { actor: undefined, ...context };
      for (const [name, args] of [
        [APP_ACCESS_ACTIONS.read, { appId: "notes" }],
        [APP_ACCESS_ACTIONS.narrow, { appId: "notes", mode: "private" }],
      ] as const) {
        expect(await engine.run(name, args, ctx)).toEqual({
          status: "error",
          error: "Only the guardian can do this.",
        });
      }
    });
  }
});
