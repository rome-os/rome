import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AgentRunnerInterface,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createRunsRepository, type RunsRepository } from "../../db/repositories/runs.js";
import { RunRecorder, keepRunAlive } from "../../lib/run-recorder.js";
import {
  changedSkills,
  commitCarrier,
  ensureUserSkillsCarrier,
  registerCarrierSkills,
  restoreCarrier,
  snapshotCarrierSkills,
  userSkillsCarrierDir,
  withCarrierLock,
} from "../../lib/user-skills-carrier.js";

const log = createAppLogger("skill_review");

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<{ agentRunner: AgentRunnerInterface; carrierDir?: string }>,
): Action {
  const { agentRunner, appContext } = deps;
  const carrierDir = deps.carrierDir ?? userSkillsCarrierDir();

  /** Runs the agent and installs what it saved. Call with the carrier lock held. */
  async function review(
    sessionId: string,
    runId: string,
    recorder: RunRecorder,
    runs: RunsRepository,
  ): Promise<ActionResult> {
    const appYaml = await readFile(join(carrierDir, "app.yaml"), "utf8");
    const before = await snapshotCarrierSkills(carrierDir);
    // Changes are found by diffing the carrier on disk, not by parsing tool
    // events, whose shape differs per provider (Codex edits carry no path).
    const diff = async () => changedSkills(before, await snapshotCarrierSkills(carrierDir));
    // Undo this run's writes, so nothing it leaves behind is mistaken for an
    // already-saved skill by the next review's snapshot.
    const rollback = async (changed: string[]) =>
      restoreCarrier(carrierDir, appYaml, before, changed);

    try {
      for await (const msg of agentRunner.run({
        agentName: "skill-review",
        workingDir: carrierDir,
        prompt:
          `Review webchat session ${sessionId} and decide whether to save a skill. ` +
          `Use get_webchat_conversations with sessionId: "${sessionId}" to fetch the conversation. ` +
          `Your working directory is the user-skills carrier (${carrierDir}); save skills as skills/<name>/SKILL.md there.`,
      })) {
        recorder.observe(msg);
      }
    } catch (err) {
      await rollback(await diff());
      runs.finish(runId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const changed = await diff();
    const outcome = recorder.outcome();
    if (outcome.status !== "completed") {
      // A failed or stopped review doesn't publish a half-written skill.
      await rollback(changed);
      runs.finish(runId, outcome);
      if (recorder.error === null)
        return { status: "ok", data: { runId, result: recorder.summary } };
      log.error("skill-review agent failed", { error: recorder.error });
      return { status: "error", error: `Skill-review agent failed: ${recorder.error}` };
    }

    // A saved SKILL.md is not a skill until the carrier listing it is
    // installed; register and install it here so the save is never silent.
    let installed: string[] | undefined;
    if (changed.length > 0) {
      try {
        installed = await registerCarrierSkills(carrierDir, changed);
        const res = await appContext.runAction("app_management", {
          op: "install",
          source: { mode: "source", path: carrierDir },
        });
        if (res.status === "error") throw new Error(res.error);
      } catch (err) {
        // One skill that can't build fails the whole carrier, so undo this
        // run's changes rather than break every later install.
        await rollback(changed);
        const error = `Skill not saved: user-skills install failed, changes rolled back: ${err instanceof Error ? err.message : String(err)}`;
        runs.finish(runId, { status: "failed", error });
        log.error("user-skills install failed", { error });
        return { status: "error", error };
      }
      // History only; a failed commit must not undo a working install.
      await commitCarrier(carrierDir, changed).catch((err) =>
        log.warn("user-skills commit failed", { error: String(err) }),
      );
    }

    runs.finish(runId, outcome);
    return {
      status: "ok",
      data: { runId, result: recorder.summary, ...(installed ? { installed } : {}) },
    };
  }

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Webchat session ID to review. If omitted, the most recent session is used.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ActionResult> {
      let sessionId = args.sessionId as string | undefined;
      let sessionName: string | null = null;

      if (sessionId) {
        const row = appContext.db.connection.get(
          sql`SELECT name FROM rome_sessions WHERE id = ${sessionId}`,
        ) as { name: string } | undefined;
        sessionName = row?.name ?? null;
      } else {
        // rome_sessions also holds channel and background runs, including this
        // review's own agent session; keep to the old webchat_sessions rows.
        const row = appContext.db.connection.get(
          sql`
            SELECT id, name FROM rome_sessions
            WHERE type IN ('webchat', 'webchat_handoff')
            ORDER BY created_at DESC
            LIMIT 1
          `,
        ) as { id: string; name: string } | undefined;
        if (!row) {
          return { status: "ok", data: { result: "No webchat sessions found." } };
        }
        sessionId = row.id;
        sessionName = row.name;
      }

      const runs = createRunsRepository(appContext.db);
      const runId = runs.start({
        kind: "skill_review",
        reviewedSessionId: sessionId,
        reviewedSessionName: sessionName,
      });
      const recorder = new RunRecorder(runs, runId);

      log.info("reviewing session", { sessionId, runId });

      // The heartbeat runs until the install finishes: waiting for the carrier
      // lock and installing are part of the run, not a stalled one.
      const stopHeartbeat = keepRunAlive(runs, runId);
      try {
        await ensureUserSkillsCarrier(carrierDir);
        // One review owns the shared carrier from its first snapshot to its
        // install, so its diff holds only its own agent's writes and a rollback
        // never touches another review's skills.
        return await withCarrierLock(carrierDir, () =>
          review(sessionId as string, runId, recorder, runs),
        );
      } finally {
        stopHeartbeat();
      }
    },
  };
}
