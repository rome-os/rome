import { describe, expect, it } from "@rstest/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstPartyApps } from "./first-party-apps";

const appsDir = fileURLToPath(new URL("../../../../rome_apps/", import.meta.url));

/** The ids `pnpm build:apps` packs: every rome_apps/<id>/ holding an app.yaml. */
function packedIds(): string[] {
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, "app.yaml")))
    .map((entry) => entry.name)
    .sort();
}

function topLevelScalar(manifest: string, key: string): string | undefined {
  return manifest.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();
}

describe("first-party app fixtures", () => {
  it("lists exactly the apps boot installs", () => {
    expect(firstPartyApps.map((app) => app.id).sort()).toEqual(packedIds());
  });

  it("matches each app.yaml's name, version, and web entry", () => {
    for (const app of firstPartyApps) {
      const manifest = readFileSync(join(appsDir, app.id, "app.yaml"), "utf8");
      expect({
        id: app.id,
        displayName: app.displayName,
        version: app.version,
        hasFrontend: app.hasFrontend,
      }).toEqual({
        id: app.id,
        displayName: topLevelScalar(manifest, "name"),
        version: topLevelScalar(manifest, "version"),
        hasFrontend: /^web:/m.test(manifest),
      });
    }
  });
});
