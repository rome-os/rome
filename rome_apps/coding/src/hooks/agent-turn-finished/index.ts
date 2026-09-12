// One-shot tagline backfill for apps built on this instance before `tagline`
// existed (rome#202). Runs once per instance: the first agent turn that
// finishes after this hook ships writes a marker into the app's settings,
// then — only if some enabled source-dir app with a web surface still lacks a
// `tagline` — summons the coding agent to run the `app_tagline_backfill`
// skill. Every later turn sees the marker and returns immediately.
//
// Bump `BACKFILL_VERSION` to run the backfill again on every instance.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentLifecycleHookDeps,
  AgentRunnerInterface,
  AgentTurnFinishedEvent,
  AgentTurnFinishedHook,
  AppSettingsRepository,
  Logger,
} from "@rome-os/app-runtime";

export const BACKFILL_SETTINGS_KEY = "coding.taglineBackfill";
export const BACKFILL_VERSION = 1;
export const BACKFILL_AGENT = "coding";
export const BACKFILL_SKILL = "coding:app_tagline_backfill";

export interface TaglineBackfillMarker {
  version: number;
  startedAt: string;
  finishedAt?: string;
  /** Source roots handed to the agent (absent when nothing needed a tagline). */
  apps?: string[];
  /** The agent's final text, kept for inspection. */
  summary?: string;
}

export interface TaglineBackfillHookDeps {
  agentRunner: Pick<AgentRunnerInterface, "run">;
  settings: AppSettingsRepository;
  logger: Pick<Logger, "info" | "warn" | "debug">;
  /** Defaults to `~/.rome/<ROME_PROFILE>/apps.lock.json`. */
  lockfilePath?: string;
}

export function defaultLockfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), ".rome", env.ROME_PROFILE || "default", "apps.lock.json");
}

interface LockfileEntry {
  source?: { mode?: string; path?: string };
  enabled?: boolean;
  state?: string;
}

/**
 * Absolute source roots of enabled, installed `mode: "source"` apps whose
 * `app.yaml` declares `web:` but no `tagline:`. Store bundles and first-party
 * apps never have `mode: "source"`, so they are skipped by construction. A
 * missing lockfile or an unreadable manifest counts as "nothing to do".
 */
export async function findAppsMissingTagline(lockfilePath: string): Promise<string[]> {
  let entries: Record<string, LockfileEntry>;
  try {
    const parsed = JSON.parse(await readFile(lockfilePath, "utf8")) as {
      apps?: Record<string, LockfileEntry>;
    };
    entries = parsed.apps ?? {};
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of Object.values(entries)) {
    if (entry.source?.mode !== "source" || !entry.source.path) continue;
    if (!entry.enabled || entry.state !== "installed") continue;
    let manifest: string;
    try {
      manifest = await readFile(join(entry.source.path, "app.yaml"), "utf8");
    } catch {
      continue;
    }
    if (/^web:/m.test(manifest) && !/^tagline:/m.test(manifest)) {
      roots.push(entry.source.path);
    }
  }
  return roots;
}

export function buildBackfillPrompt(roots: string[]): string {
  return [
    `Read the \`${BACKFILL_SKILL}\` skill with read_skill and run it in AUTO mode for these apps (absolute source roots):`,
    ...roots.map((root) => `- ${root}`),
  ].join("\n");
}

export class TaglineBackfillHook implements AgentTurnFinishedHook {
  private running = false;

  constructor(private readonly deps: TaglineBackfillHookDeps) {}

  async onAgentTurnFinished(_event: AgentTurnFinishedEvent): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const marker = await this.deps.settings.get<TaglineBackfillMarker>(BACKFILL_SETTINGS_KEY);
      if (marker && marker.version >= BACKFILL_VERSION) return;
      await this.backfill();
    } catch (err) {
      this.deps.logger.warn("tagline backfill failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }

  private async backfill(): Promise<void> {
    // Mark first: the backfill runs once whether or not it succeeds. The
    // manual `/app_tagline_backfill` skill covers anything it leaves behind.
    const started: TaglineBackfillMarker = {
      version: BACKFILL_VERSION,
      startedAt: new Date().toISOString(),
    };
    await this.deps.settings.set(BACKFILL_SETTINGS_KEY, started);

    const roots = await findAppsMissingTagline(this.deps.lockfilePath ?? defaultLockfilePath());
    if (roots.length === 0) {
      await this.deps.settings.set(BACKFILL_SETTINGS_KEY, {
        ...started,
        finishedAt: new Date().toISOString(),
      });
      this.deps.logger.debug("tagline backfill: nothing to do");
      return;
    }

    this.deps.logger.info("tagline backfill started", { apps: roots });
    let summary = "";
    for await (const msg of this.deps.agentRunner.run({
      agentName: BACKFILL_AGENT,
      prompt: buildBackfillPrompt(roots),
    })) {
      if (msg.type === "result") summary = String(msg.content ?? "");
      if (msg.type === "error") throw new Error(String(msg.error));
    }
    await this.deps.settings.set(BACKFILL_SETTINGS_KEY, {
      ...started,
      finishedAt: new Date().toISOString(),
      apps: roots,
      summary,
    });
    this.deps.logger.info("tagline backfill finished", { apps: roots });
  }
}

export function createHook(deps: AgentLifecycleHookDeps): AgentTurnFinishedHook {
  if (!deps.agentRunner) {
    throw new Error("Tagline backfill hook requires agentRunner");
  }
  if (!deps.appContext) {
    throw new Error("Tagline backfill hook requires appContext");
  }
  return new TaglineBackfillHook({
    agentRunner: deps.agentRunner,
    settings: deps.appContext.repositories.settings,
    logger: deps.logger,
  });
}
