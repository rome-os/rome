import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  assertCoreRequiredAppsPacked,
  CoreRequiredAppsError,
  deriveCoreRequiredApps,
} from "./core-required.js";

describe("deriveCoreRequiredApps", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rome-core-required-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("always includes the apps it is told are required", async () => {
    await expect(
      deriveCoreRequiredApps({
        projectRoot: root,
        alwaysRequired: ["system", "inbox"],
        coreAgentsRoot: join(root, "agents"),
        seedAppsRoot: join(root, "rome_apps"),
      }),
    ).resolves.toEqual(["inbox", "system"]);
  });

  it("derives an owning app from a canonical core subagent reference", async () => {
    const coreAgentsRoot = join(root, "agents");
    const seedAppsRoot = join(root, "rome_apps");
    await mkdir(coreAgentsRoot, { recursive: true });
    await mkdir(join(seedAppsRoot, "planner", "src", "agents"), { recursive: true });
    await writeFile(
      join(coreAgentsRoot, "main.yaml"),
      "name: main\nallowedSubagents: [planner:planning]\n",
    );
    await writeFile(
      join(seedAppsRoot, "planner", "src", "agents", "planning.yaml"),
      "name: planning\n",
    );

    await expect(
      deriveCoreRequiredApps({
        projectRoot: root,
        alwaysRequired: [],
        coreAgentsRoot,
        seedAppsRoot,
      }),
    ).resolves.toContain("planner");
  });
});

describe("assertCoreRequiredAppsPacked", () => {
  it("accepts when every agent-required app has a packed first-party artifact", () => {
    expect(() =>
      assertCoreRequiredAppsPacked(["system", "inbox"], ["system", "inbox", "dream"]),
    ).not.toThrow();
  });

  it("fails boot loudly when an agent requires an app with no packed artifact", () => {
    expect(() => assertCoreRequiredAppsPacked(["system", "ghost"], ["system"])).toThrow(
      CoreRequiredAppsError,
    );
    expect(() => assertCoreRequiredAppsPacked(["system", "ghost"], ["system"])).toThrow(
      /ghost[\s\S]*pnpm build:apps/,
    );
  });
});
