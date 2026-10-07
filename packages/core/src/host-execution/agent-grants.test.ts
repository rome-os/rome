import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";
import { ActionRegistryImpl } from "../actions/registry.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { ActionConfigSchema } from "../apps/packaging/artifact-config.js";

// Root-on-host actions must reach only the main agent. A wildcard allow-list
// (`actions: ["*"]`) is held by triage, validation and exploration agents,
// some of which read untrusted input, so these actions must be explicit (#679).
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const HOST_ACTIONS = ["execute-root-script", "manage-root-script"];

async function agentManifests(): Promise<Array<{ id: string; actions: string[] }>> {
  const dirs: Array<[owner: string | undefined, dir: string]> = [
    [undefined, join(REPO, "packages/core/agents")],
  ];
  for (const app of await readdir(join(REPO, "rome_apps"))) {
    dirs.push([app, join(REPO, "rome_apps", app, "agents")]);
    dirs.push([app, join(REPO, "rome_apps", app, "src/agents")]);
  }
  const agents = [];
  for (const [owner, dir] of dirs) {
    const files = await readdir(dir).catch(() => []);
    for (const file of files.filter((name) => /\.ya?ml$/.test(name))) {
      const config = parseYaml(await readFile(join(dir, file), "utf-8"));
      agents.push({
        id: owner ? `${owner}:${config.name}` : config.name,
        actions: config.actions ?? [],
      });
    }
  }
  return agents;
}

describe("host root action grants", () => {
  it("grants the root actions to the main agent only", async () => {
    const registry = new ActionRegistryImpl([], {
      legacyBindings: createEmptyLegacyArtifactBindings(),
    });
    for (const dir of HOST_ACTIONS) {
      const path = join(REPO, "rome_apps/system/src/actions", dir, "action.yaml");
      const config = ActionConfigSchema.parse(parseYaml(await readFile(path, "utf-8")));
      registry.register(
        { config, inputSchema: { type: "object" }, execute: async () => ({ status: "ok" }) },
        {
          kind: "action",
          ownerType: "app",
          ownerId: "system",
          publicName: config.name,
          aliases: [],
          sourcePath: path,
          formatVersion: 2,
        },
      );
    }

    const agents = await agentManifests();
    const holders = agents
      .filter((agent) => registry.getForAgent(agent.actions).length > 0)
      .map((agent) => agent.id);
    expect(holders).toEqual(["main"]);
    // The untrusted-input triage agent holds nothing it could be steered into.
    expect(agents.find((agent) => agent.id === "inbox:sentinel")?.actions).toEqual([]);
    expect(
      registry
        .getForAgent(agents.find((agent) => agent.id === "main")!.actions)
        .map((action) => action.config.name)
        .sort(),
    ).toEqual(["system:execute_root_script", "system:manage_root_script"]);
  });
});
