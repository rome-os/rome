import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AgentMessage, AgentTurnFinishedEvent, RunParams } from "@rome-os/app-runtime";
import {
  BACKFILL_MAX_ATTEMPTS,
  BACKFILL_SETTINGS_KEY,
  BACKFILL_SKILL,
  BACKFILL_VERSION,
  defaultLockfilePath,
  findAppsMissingTagline,
  TaglineBackfillHook,
  type TaglineBackfillMarker,
} from "./index.js";

const event = { type: "agent-turn-finished" } as AgentTurnFinishedEvent;
const logger = { info() {}, warn() {}, debug() {} };

function createRunner(messages: AgentMessage[] = [{ type: "result", content: "done" }]) {
  const calls: RunParams[] = [];
  return {
    calls,
    async *run(params: RunParams): AsyncIterable<AgentMessage> {
      calls.push(params);
      yield* messages;
    },
  };
}

function createSettings(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const sets: unknown[] = [];
  return {
    store,
    sets,
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T | undefined) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
      sets.push(value);
    },
  };
}

describe("coding tagline backfill hook", () => {
  let tempDir = "";
  let lockfilePath = "";

  /** Writes `<tempDir>/apps/<id>/app.yaml` and returns the app root. */
  async function writeApp(id: string, manifest: string): Promise<string> {
    const root = join(tempDir, "apps", id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "app.yaml"), manifest);
    return root;
  }

  async function writeLockfile(apps: Record<string, unknown>): Promise<void> {
    await writeFile(lockfilePath, JSON.stringify({ schemaVersion: 3, apps }));
  }

  function sourceEntry(path: string, overrides: Record<string, unknown> = {}) {
    return { source: { mode: "source", path }, enabled: true, state: "installed", ...overrides };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tagline-backfill-"));
    lockfilePath = join(tempDir, "apps.lock.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("defaults the lockfile to the profile dir", () => {
    expect(defaultLockfilePath({ ROME_PROFILE: "work" })).toMatch(
      /\/\.rome\/work\/apps\.lock\.json$/,
    );
    expect(defaultLockfilePath({})).toMatch(/\/\.rome\/default\/apps\.lock\.json$/);
  });

  describe("findAppsMissingTagline", () => {
    it("selects enabled source-dir apps with a web surface and no tagline", async () => {
      const missing = await writeApp(
        "missing",
        "id: missing\nweb:\n  manifest: web/manifest.json\n",
      );
      const hasTagline = await writeApp(
        "has-tagline",
        "id: has-tagline\ntagline: Already set\nweb:\n  manifest: web/manifest.json\n",
      );
      const noWeb = await writeApp("no-web", "id: no-web\nactions:\n  - actions/run\n");
      const disabled = await writeApp(
        "disabled",
        "id: disabled\nweb:\n  manifest: web/manifest.json\n",
      );
      const broken = await writeApp("broken", "id: broken\nweb:\n  manifest: web/manifest.json\n");
      await writeLockfile({
        missing: sourceEntry(missing),
        "has-tagline": sourceEntry(hasTagline),
        "no-web": sourceEntry(noWeb),
        disabled: sourceEntry(disabled, { enabled: false }),
        broken: sourceEntry(broken, { state: "broken" }),
        store: { source: { mode: "appstore", listing: "@a/b" }, enabled: true, state: "installed" },
        bundle: { source: { mode: "bundle", path: missing }, enabled: true, state: "installed" },
        gone: sourceEntry(join(tempDir, "apps", "gone")),
      });

      expect(await findAppsMissingTagline(lockfilePath)).toEqual([missing]);
    });

    it("treats a missing lockfile as nothing to do", async () => {
      expect(await findAppsMissingTagline(join(tempDir, "nope.json"))).toEqual([]);
    });

    it("throws on a lockfile it cannot parse", async () => {
      await writeFile(lockfilePath, "{ not json");
      await expect(findAppsMissingTagline(lockfilePath)).rejects.toThrow();
    });
  });

  describe("onAgentTurnFinished", () => {
    it("does nothing when the marker is finished at the current version", async () => {
      const runner = createRunner();
      const settings = createSettings({
        [BACKFILL_SETTINGS_KEY]: {
          version: BACKFILL_VERSION,
          startedAt: "2026-01-01T00:00:00Z",
          attempts: 1,
          finishedAt: "2026-01-01T00:01:00Z",
        },
      });
      const hook = new TaglineBackfillHook({
        agentRunner: runner,
        settings,
        logger,
        lockfilePath: join(tempDir, "nope.json"),
      });

      await hook.onAgentTurnFinished(event);

      expect(runner.calls).toHaveLength(0);
      expect(settings.sets).toHaveLength(0);
    });

    it("writes a finished marker without summoning when no app needs a tagline", async () => {
      const root = await writeApp(
        "ok",
        "id: ok\ntagline: Fine\nweb:\n  manifest: web/manifest.json\n",
      );
      await writeLockfile({ ok: sourceEntry(root) });
      const runner = createRunner();
      const settings = createSettings();
      const hook = new TaglineBackfillHook({ agentRunner: runner, settings, logger, lockfilePath });

      await hook.onAgentTurnFinished(event);

      expect(runner.calls).toHaveLength(0);
      const marker = settings.store.get(BACKFILL_SETTINGS_KEY) as TaglineBackfillMarker;
      expect(marker.version).toBe(BACKFILL_VERSION);
      expect(marker.attempts).toBe(1);
      expect(marker.finishedAt).toBeDefined();
      expect(marker.apps).toBeUndefined();
    });

    it("marks first, then summons the coding agent once with the app roots", async () => {
      const root = await writeApp("todo", "id: todo\nweb:\n  manifest: web/manifest.json\n");
      await writeLockfile({ todo: sourceEntry(root) });
      const runner = createRunner([{ type: "result", content: "Added 1 tagline." }]);
      const settings = createSettings();
      const hook = new TaglineBackfillHook({ agentRunner: runner, settings, logger, lockfilePath });

      await hook.onAgentTurnFinished(event);
      await hook.onAgentTurnFinished(event);

      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.agentName).toBe("coding");
      expect(runner.calls[0]?.prompt).toContain(
        "`coding:app_tagline_backfill` skill with read_skill",
      );
      expect(runner.calls[0]?.prompt).toContain("AUTO mode");
      expect(runner.calls[0]?.prompt).toContain(`- ${root}`);

      const [first, last] = [settings.sets[0], settings.sets.at(-1)] as TaglineBackfillMarker[];
      expect(first.version).toBe(BACKFILL_VERSION);
      expect(first.finishedAt).toBeUndefined();
      expect(last).toMatchObject({
        version: BACKFILL_VERSION,
        attempts: 1,
        apps: [root],
        summary: "Added 1 tagline.",
      });
      expect(last.finishedAt).toBeDefined();
    });

    it("retries a failed run on later turns, up to the attempt cap", async () => {
      const root = await writeApp("todo", "id: todo\nweb:\n  manifest: web/manifest.json\n");
      await writeLockfile({ todo: sourceEntry(root) });
      const runner = createRunner([{ type: "error", error: "model unavailable" }]);
      const settings = createSettings();
      const hook = new TaglineBackfillHook({ agentRunner: runner, settings, logger, lockfilePath });

      await expect(hook.onAgentTurnFinished(event)).resolves.toBeUndefined();
      let marker = settings.store.get(BACKFILL_SETTINGS_KEY) as TaglineBackfillMarker;
      expect(marker).toMatchObject({ version: BACKFILL_VERSION, attempts: 1 });
      expect(marker.lastError).toBe("model unavailable");
      expect(marker.finishedAt).toBeUndefined();

      for (let i = 1; i < BACKFILL_MAX_ATTEMPTS + 2; i++) {
        await hook.onAgentTurnFinished(event);
      }

      expect(runner.calls).toHaveLength(BACKFILL_MAX_ATTEMPTS);
      marker = settings.store.get(BACKFILL_SETTINGS_KEY) as TaglineBackfillMarker;
      expect(marker.attempts).toBe(BACKFILL_MAX_ATTEMPTS);
      expect(marker.finishedAt).toBeUndefined();
    });

    it("leaves a recent in-progress marker to the instance that owns it", async () => {
      const root = await writeApp("todo", "id: todo\nweb:\n  manifest: web/manifest.json\n");
      await writeLockfile({ todo: sourceEntry(root) });
      const runner = createRunner();
      const settings = createSettings({
        [BACKFILL_SETTINGS_KEY]: {
          version: BACKFILL_VERSION,
          startedAt: new Date().toISOString(),
          attempts: 1,
        },
      });
      const hook = new TaglineBackfillHook({ agentRunner: runner, settings, logger, lockfilePath });

      await hook.onAgentTurnFinished(event);

      expect(runner.calls).toHaveLength(0);
      expect(settings.sets).toHaveLength(0);
    });

    it("records a failed scan as an attempt without settling", async () => {
      await writeFile(lockfilePath, "{ not json");
      const runner = createRunner();
      const settings = createSettings();
      const hook = new TaglineBackfillHook({ agentRunner: runner, settings, logger, lockfilePath });

      await expect(hook.onAgentTurnFinished(event)).resolves.toBeUndefined();

      expect(runner.calls).toHaveLength(0);
      const marker = settings.store.get(BACKFILL_SETTINGS_KEY) as TaglineBackfillMarker;
      expect(marker).toMatchObject({ version: BACKFILL_VERSION, attempts: 1 });
      expect(marker.lastError).toBeDefined();
      expect(marker.finishedAt).toBeUndefined();
    });

    it("resumes an interrupted run and finishes once the work is done", async () => {
      const root = await writeApp(
        "ok",
        "id: ok\ntagline: Fine\nweb:\n  manifest: web/manifest.json\n",
      );
      await writeLockfile({ ok: sourceEntry(root) });
      const runner = createRunner();
      const settings = createSettings({
        [BACKFILL_SETTINGS_KEY]: {
          version: BACKFILL_VERSION,
          startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          attempts: 1,
        },
      });
      const hook = new TaglineBackfillHook({ agentRunner: runner, settings, logger, lockfilePath });

      await hook.onAgentTurnFinished(event);

      expect(runner.calls).toHaveLength(0);
      const marker = settings.store.get(BACKFILL_SETTINGS_KEY) as TaglineBackfillMarker;
      expect(marker).toMatchObject({ version: BACKFILL_VERSION, attempts: 2 });
      expect(marker.finishedAt).toBeDefined();
    });
  });
});
