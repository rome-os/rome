import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";
import { ActionConfigSchema } from "./artifact-config.js";

// ActionLoader skips an app action whose manifest fails to parse, and the
// packaging validator only runs at pack time, so a malformed first-party
// action.yaml would otherwise pass the unit suite and drop the action at
// runtime.
const ROME_APPS = join(dirname(fileURLToPath(import.meta.url)), "../../../../../rome_apps");

async function findActionManifests(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...(await findActionManifests(join(dir, entry.name))));
    } else if (entry.name === "action.yaml") {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const manifests = await findActionManifests(ROME_APPS);

describe("first-party action manifests", () => {
  it("finds the first-party action manifests", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(
    manifests.map((path): [string, string] => [relative(ROME_APPS, path), path]),
  )("%s parses as a valid action config", async (_label, path) => {
    const raw = parseYaml(await readFile(path, "utf-8"));
    const result = ActionConfigSchema.safeParse(raw);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });
});
