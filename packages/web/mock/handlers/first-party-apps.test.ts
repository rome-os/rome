import { describe, expect, it } from "@rstest/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { firstPartyApps } from "./first-party-apps";

const appsDir = fileURLToPath(new URL("../../../../rome_apps/", import.meta.url));

/** The ids `pnpm build:apps` packs: every rome_apps/<id>/ holding an app.yaml. */
function packedIds(): string[] {
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, "app.yaml")))
    .map((entry) => entry.name)
    .sort();
}

describe("first-party app fixtures", () => {
  it("lists exactly the apps boot installs", () => {
    expect(firstPartyApps.map((app) => app.id).sort()).toEqual(packedIds());
  });

  it("matches each app.yaml's name, version, description, and web entry", () => {
    for (const app of firstPartyApps) {
      const manifest = parseYaml(readFileSync(join(appsDir, app.id, "app.yaml"), "utf8"));
      expect({
        id: app.id,
        displayName: app.displayName,
        version: app.version,
        description: app.description,
        hasFrontend: app.hasFrontend,
      }).toEqual({
        id: app.id,
        displayName: manifest.name,
        version: manifest.version,
        description: manifest.description,
        hasFrontend: manifest.web !== undefined,
      });
    }
  });
});
