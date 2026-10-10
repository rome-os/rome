import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { getCoreRoot } from "../paths.js";
import type { ArtifactRef } from "./state.js";

/**
 * Core agents shipped under `packages/core/agents/`. Every other artifact kind
 * is app-owned, so loaders merge only agents with the AppCatalog's artifacts.
 */
export async function listCoreAgents(coreRoot: string = getCoreRoot()): Promise<ArtifactRef[]> {
  const dir = join(coreRoot, "agents");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => extname(entry.name) === ".yaml" || extname(entry.name) === ".yml")
    .map((entry) => ({
      formatVersion: 2 as const,
      kind: "agent" as const,
      publicName: entry.name.replace(/\.(yaml|yml)$/u, ""),
      aliases: [] as readonly string[],
      ownerType: "core" as const,
      ownerId: "core",
      absolutePath: join(dir, entry.name),
    }));
}
