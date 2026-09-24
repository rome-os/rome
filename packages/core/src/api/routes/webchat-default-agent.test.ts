import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createWebchatRuntime } from "./webchat.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { WEBCHAT_DEFAULT_AGENT_SETTING } from "../../webchat/default-agent.js";

const HELPER = "helper-app:helper";

describe("Webchat default agent routes", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let loaded: Set<string>;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    loaded = new Set([HELPER, "core:main"]);
    deps.agentLoader = {
      has: (name: string) => loaded.has(name),
      getCanonicalName: (name: string) => name,
      getRecord: (name: string) => ({
        config: { name: name.split(":")[1], description: "" },
        metadata: { ownerId: name.split(":")[0], ownerType: "app" },
      }),
    } as unknown as typeof deps.agentLoader;
  });

  afterEach(() => testDb.close());

  const routes = () => createWebchatRuntime(deps).routes;
  const put = (agentName: unknown) =>
    routes().request("/chat/default-agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentName }),
    });
  const get = async () => (await routes().request("/chat/default-agent")).json();

  it("presents an instance with no saved choice as the main agent", async () => {
    expect(await get()).toEqual({ saved: null, effective: "main" });
  });

  it("stores a loaded agent with its owning app and reads it back", async () => {
    const res = await put(HELPER);

    const saved = { agentName: HELPER, ownerAppId: "helper-app" };
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved, effective: HELPER });
    expect(await deps.settingsRepo.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toEqual(saved);
    expect(await get()).toEqual({ saved, effective: HELPER });
  });

  it("rejects an agent that is not loaded and stores nothing", async () => {
    const res = await put("gone-app:ghost");

    expect(res.status).toBe(400);
    expect(await deps.settingsRepo.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();
  });

  it.each([
    ["core:main"],
    ["main"],
    [null],
    [""],
  ])("deletes the row when %j is chosen", async (choice) => {
    await put(HELPER);

    const res = await put(choice);

    expect(await res.json()).toEqual({ saved: null, effective: "main" });
    expect(await deps.settingsRepo.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toBeNull();
  });

  it("reads an unloaded saved agent as main without clearing it", async () => {
    await put(HELPER);
    loaded.delete(HELPER);

    const saved = { agentName: HELPER, ownerAppId: "helper-app" };
    expect(await get()).toEqual({ saved, effective: "main" });
    expect(await deps.settingsRepo.get(WEBCHAT_DEFAULT_AGENT_SETTING)).toEqual(saved);
  });
});
