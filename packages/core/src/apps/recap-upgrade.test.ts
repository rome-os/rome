import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { RomeAppContext } from "@rome-os/app-runtime";
import { createApiHandler } from "../../../../rome_apps/system/src/api/index.js";
import { getRecapSettings } from "../../../../rome_apps/system/src/settings.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, testChatRepository, type TestDb } from "../test/helpers.js";
import { installFirstPartyAppsAtBoot } from "./boot-upgrade.js";
import { packArtifact } from "./packaging/index.js";
import { preserveRecapOptOutAtBoot } from "./recap-upgrade.js";
import { createAppRuntimeRepositories } from "./repositories.js";
import { createTestApps, type TestAppsHarness } from "./test-helpers.js";

describe("recap to system upgrade", () => {
  let harness: TestAppsHarness;
  let projectRoot: string;
  let testDb: TestDb;
  let settingsRepo: SettingsRepository;

  beforeEach(async () => {
    harness = await createTestApps();
    projectRoot = await mkdtemp(join(tmpdir(), "rome-recap-upgrade-"));
    testDb = createTestDb();
    settingsRepo = new SettingsRepository(testDb.db);
  });

  afterEach(async () => {
    testDb.close();
    await harness.cleanup();
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function pack(appId: string, version: string) {
    const source = join(projectRoot, "src", appId);
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "app.yaml"),
      `formatVersion: 1\nid: ${appId}\nversion: ${version}\ndescription: upgrade fixture\n`,
    );
    await packArtifact(source, join(projectRoot, "dist", "first-party-artifacts", appId), {
      appId,
      clean: true,
    });
  }

  async function boot() {
    await preserveRecapOptOutAtBoot(harness.appManager, settingsRepo);
    return installFirstPartyAppsAtBoot({
      appManager: harness.appManager,
      appCatalog: harness.catalog,
      projectRoot,
      retryDelayMs: 0,
    });
  }

  function repositories() {
    return createAppRuntimeRepositories({
      settingsRepo,
      webchatRepo: new WebChatRepository(testDb.db),
      chatRepo: testChatRepository(testDb.db),
    });
  }

  it.each([
    true,
    false,
  ])("preserves effective recap consent across an upgrade (legacy app enabled: %s)", async (appEnabled) => {
    await pack("recap", "0.1.1");
    await pack("system", "0.2.20");
    await boot();
    await settingsRepo.set("recap.enabled", true);
    await settingsRepo.set("recap.createAudio", true);
    await settingsRepo.set("recap.threshold", "long");
    await settingsRepo.set("recap.audioSpeed", "slower");
    await harness.appManager.setEnabled("recap", appEnabled);

    await rm(join(projectRoot, "dist", "first-party-artifacts", "recap"), { recursive: true });
    await pack("system", "0.2.21");
    await harness.appManager.boot();
    const result = await boot();

    expect(result.removed).toEqual(["recap"]);
    expect(result.reinstalled).toEqual(["system"]);
    expect(harness.catalog.get("recap")).toBeNull();
    expect(await harness.appManager.readLockfileEntry("recap")).toBeNull();
    const handler = createApiHandler({
      app: { id: "system", version: "0.2.21" },
      repositories: repositories(),
    } as RomeAppContext);
    const response = await handler.handle({
      method: "GET",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
    });
    expect(await response.json()).toEqual({
      enabled: appEnabled,
      createAudio: true,
      threshold: "long",
      audioSpeed: "slower",
    });
    await settingsRepo.set("recap.enabled", true);
    expect((await boot()).removed).toEqual([]);
    expect(await settingsRepo.get("recap.enabled")).toBe(true);
  });

  it("does not treat stored audio consent as recap consent", async () => {
    await settingsRepo.set("recap.createAudio", true);
    expect(await getRecapSettings(repositories().settings)).toEqual({
      enabled: false,
      createAudio: true,
      threshold: "medium",
      audioSpeed: "faster",
    });
  });
});
