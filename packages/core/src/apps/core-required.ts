import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { getRepoAppsDir } from "../paths.js";
import { getCoreAgentsRoot } from "./authoring.js";

/**
 * Core apps that must be present even when no current core agent references
 * their subagents directly. `system` provides the core action set; the others
 * are baseline capabilities the runtime depends on.
 */
const ALWAYS_REQUIRED = [
  "system",
  "assistant",
  "coding",
  "inbox",
  "browser-automation",
  "connector",
  // First-run onboarding: the web lands a freshly-onboarded guardian on this
  // app, whose web UI opens the conversational welcome flow.
  "welcome-to-rome",
  // Guardian-facing skills surface: browse/invoke + import/generate.
  "skills",
] as const;

export interface CoreRequiredAppFailure {
  appId: string;
  error: string;
}

export class CoreRequiredAppsError extends Error {
  readonly failures: readonly CoreRequiredAppFailure[];

  constructor(failures: readonly CoreRequiredAppFailure[]) {
    const summary = failures.map((f) => `  - ${f.appId}: ${f.error}`).join("\n");
    super(
      `Rome cannot start: ${failures.length} core-required app(s) failed to install or are unavailable:\n${summary}\n` +
        `These apps host the subagents and actions that the core agents in packages/core/agents reference. ` +
        `Restore them under rome_apps/ or fix the install errors above.`,
    );
    this.name = "CoreRequiredAppsError";
    this.failures = failures;
  }
}

/**
 * Boot assertion: every app the core agents require must be among the packed
 * first-party artifacts that boot installs. Boot installs *all* packed
 * first-party apps, so this only guards against a core agent referencing an
 * app that was never packed (deleted from rome_apps/, or dropped from the
 * `pnpm build:apps` output).
 */
export function assertCoreRequiredAppsPacked(
  required: readonly string[],
  packedFirstPartyAppIds: readonly string[],
): void {
  const packed = new Set(packedFirstPartyAppIds);
  const failures = required
    .filter((appId) => !packed.has(appId))
    .map((appId) => ({
      appId,
      error:
        `no packed artifact at dist/first-party-artifacts/${appId} — ` +
        `re-run \`pnpm build:apps\` (or restore rome_apps/${appId})`,
    }));
  if (failures.length > 0) {
    throw new CoreRequiredAppsError(failures);
  }
}

interface AgentManifest {
  name?: unknown;
  allowedSubagents?: unknown;
}

async function readAgentYaml(path: string): Promise<AgentManifest | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === "object" ? (parsed as AgentManifest) : null;
  } catch {
    return null;
  }
}

async function findAgentYamlsUnder(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
        const segments = relative(root, full).split(sep);
        if (segments.length >= 2 && segments[segments.length - 2] === "agents") {
          out.push(full);
        }
      }
    }
  }
  return out;
}

interface DiscoveredAgent {
  name: string;
  appId: string;
  yamlPath: string;
}

async function discoverRomeAppAgents(seedAppsRoot: string): Promise<DiscoveredAgent[]> {
  if (!existsSync(seedAppsRoot)) return [];
  const appDirs = await readdir(seedAppsRoot, { withFileTypes: true });
  const out: DiscoveredAgent[] = [];
  for (const appDir of appDirs) {
    if (!appDir.isDirectory() || appDir.name.startsWith(".")) continue;
    const appRoot = join(seedAppsRoot, appDir.name);
    const yamls = await findAgentYamlsUnder(appRoot);
    for (const yamlPath of yamls) {
      const manifest = await readAgentYaml(yamlPath);
      if (manifest && typeof manifest.name === "string" && manifest.name.length > 0) {
        out.push({ name: manifest.name, appId: appDir.name, yamlPath });
      }
    }
  }
  return out;
}

async function readCoreAgentSubagentRefs(coreAgentsRoot: string): Promise<string[]> {
  if (!existsSync(coreAgentsRoot)) return [];
  const entries = await readdir(coreAgentsRoot, { withFileTypes: true });
  const refs = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const manifest = await readAgentYaml(join(coreAgentsRoot, entry.name));
    if (!manifest || !Array.isArray(manifest.allowedSubagents)) continue;
    for (const ref of manifest.allowedSubagents) {
      if (typeof ref === "string" && ref.length > 0) refs.add(ref);
    }
  }
  return [...refs];
}

export interface DeriveCoreRequiredAppsOptions {
  projectRoot: string;
  coreAgentsRoot?: string;
  seedAppsRoot?: string;
}

/**
 * Compute the set of rome_apps the core runtime depends on by joining
 * `packages/core/agents/*.yaml` `allowedSubagents` against the agent yamls
 * under `rome_apps/<app>/{agents,src/agents}/*.yaml`. Throws if any subagent
 * referenced by a core agent has no owning app — that would otherwise surface
 * later as a confusing "unknown subagent" at agent-load time.
 */
export async function deriveCoreRequiredApps(
  options: DeriveCoreRequiredAppsOptions,
): Promise<readonly string[]> {
  const coreAgentsRoot = options.coreAgentsRoot ?? getCoreAgentsRoot(options.projectRoot);
  const seedAppsRoot = options.seedAppsRoot ?? getRepoAppsDir(options.projectRoot);

  const [subagentRefs, romeAppAgents] = await Promise.all([
    readCoreAgentSubagentRefs(coreAgentsRoot),
    discoverRomeAppAgents(seedAppsRoot),
  ]);

  const subagentToApp = new Map<string, string>();
  for (const agent of romeAppAgents) {
    subagentToApp.set(`${agent.appId}:${agent.name}`, agent.appId);
    // Version 1 core-agent configs may still carry a bare legacy reference.
    if (!subagentToApp.has(agent.name)) subagentToApp.set(agent.name, agent.appId);
  }

  const required = new Set<string>(ALWAYS_REQUIRED);
  const orphans: string[] = [];
  for (const ref of subagentRefs) {
    const owner = subagentToApp.get(ref);
    if (owner) required.add(owner);
    else orphans.push(ref);
  }

  if (orphans.length > 0) {
    throw new Error(
      `Core agents reference subagents with no owning rome_app: ${orphans.join(", ")}. ` +
        `Either add the agent yaml under rome_apps/<owner>/agents/ or remove the reference.`,
    );
  }

  return [...required].sort();
}
