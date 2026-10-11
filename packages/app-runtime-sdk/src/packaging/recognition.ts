import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { safeIsDir } from "./path-utils.js";

/**
 * Sentinel file `packArtifact` writes into every packed artifact. Its
 * presence is the positive proof that a directory was produced by the pack
 * pipeline — source workspaces never contain it (the snapshot couldn't have
 * written it), so `classifyAppDir` keys "bundle" off it instead of guessing
 * from negative evidence. Content is deterministic (`{ appId, version }`),
 * so re-packing unchanged source still converges to the same artifact hash.
 */
export const PACKED_ARTIFACT_SENTINEL = ".rome-artifact.json";

/**
 * Top-level entries that only ever exist in a source workspace, never in a
 * packed artifact (pack's snapshot excludes `src`/`.git`/`.rome` and drops
 * tsconfig/drizzle config files). Classification keys on the pack sentinel,
 * not on these — a source repo may legitimately have none of them (pure-YAML
 * apps like a bare actions/ tree). They are only used to pick the more
 * helpful error message when a `bundle` install points at a non-artifact.
 *
 * `pnpm-workspace.yaml` is deliberately NOT a marker: the no-`appRoot`
 * snapshot preserves it in the packed artifact (it keeps the bundle's
 * `pnpm install --prod` from crawling up to an enclosing workspace), so
 * bundles legitimately contain it.
 */
const SOURCE_WORKSPACE_MARKER_ENTRIES = ["src", ".git", ".rome", "tsconfig.json"] as const;

export type AppDirKind = "missing" | "no-manifest" | "source" | "bundle";

/**
 * Classify what kind of app directory `path` is. Used to cross-check a
 * caller's declared install mode (`source` vs `bundle`) against what's
 * actually on disk, so a wrong path fails loudly instead of installing the
 * wrong bytes. "bundle" requires positive proof — the sentinel `packArtifact`
 * writes; any other directory with a manifest is classified as a source
 * workspace. (The bundle-mode install gate layers a legacy fallback on top:
 * a marker-free, manifest-valid dir explicitly declared as `bundle` is still
 * accepted, so pre-sentinel artifacts remain installable.)
 */
export function classifyAppDir(path: string): AppDirKind {
  if (!existsSync(path) || !safeIsDir(path)) return "missing";
  if (!existsSync(join(path, "app.yaml"))) return "no-manifest";
  return existsSync(join(path, PACKED_ARTIFACT_SENTINEL)) ? "bundle" : "source";
}

/**
 * Whether `path` shows recognizable source-workspace structure. Only used to
 * word the `bundle`-mode rejection: a marker-bearing dir gets "this is a
 * source workspace, install it as source"; a marker-free one may be a stale
 * pre-sentinel artifact, so the error offers re-packing too.
 */
export function hasSourceWorkspaceMarkers(path: string): boolean {
  for (const entry of SOURCE_WORKSPACE_MARKER_ENTRIES) {
    if (existsSync(join(path, entry))) return true;
  }
  try {
    return readdirSync(path).some((name) => name.startsWith("drizzle.config."));
  } catch {
    return false;
  }
}

/**
 * When `path` is the conventional daemon pack target (`<repo>/.rome/artifact`),
 * return `<repo>` so error messages can name the exact source dir to install.
 */
export function sourceRootForArtifactPath(path: string): string | null {
  const normalized = resolve(path);
  if (basename(normalized) !== "artifact") return null;
  const romeDir = dirname(normalized);
  if (basename(romeDir) !== ".rome") return null;
  return dirname(romeDir);
}
