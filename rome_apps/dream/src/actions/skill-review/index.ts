import { rm } from "node:fs/promises";
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
  publishCarrierSkills,
  snapshotCarrierSkills,
  stageCarrierSkills,
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

  /** Runs the agent on a staging copy and publishes what it saved. */
  async function review(
    sessionId: string,
    runId: string,
    recorder: RunRecorder,
    runs: RunsRepository,
  ): Promise<ActionResult> {
    const staging = await stageCarrierSkills(carrierDir);
    try {
      const before = await snapshotCarrierSkills(staging);
      try {
        for await (const msg of agentRunner.run({
          agentName: "skill-review",
          workingDir: staging,
          prompt:
            `Review webchat session ${sessionId} and decide whether to save a skill. ` +
            `Use get_webchat_conversations with sessionId: "${sessionId}" to fetch the conversation. ` +
            `Your working directory (${staging}) is a staging copy of the user-skills carrier; save skills as skills/<name>/SKILL.md there.`,
        })) {
          recorder.observe(msg);
        }
      } catch (err) {
        runs.finish(runId, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // A failed or stopped review publishes nothing; its staging copy is dropped.
      const outcome = recorder.outcome();
      if (outcome.status !== "completed") {
        runs.finish(runId, outcome);
        if (recorder.error === null) {
          return { status: "ok", data: { runId, result: recorder.summary } };
        }
        log.error("skill-review agent failed", { error: recorder.error });
        return { status: "error", error: `Skill-review agent failed: ${recorder.error}` };
      }

      // A saved SKILL.md is not a skill until the carrier listing it is
      // installed, so publish and install it here; the save is never silent.
      // Changes are found by diffing the staging copy, not by parsing tool
      // events, whose shape differs per provider (Codex edits carry no path).
      const after = await snapshotCarrierSkills(staging);
      const changed = changedSkills(before, after);
      let installed: string[] | undefined;
      if (changed.length > 0) {
        try {
          installed = await withCarrierLock(carrierDir, async () => {
            const paths = await publishCarrierSkills(
              carrierDir,
              before,
              new Map(changed.map((name) => [name, after.get(name) as Buffer])),
              async () => {
                const res = await appContext.runAction("app_management", {
                  op: "install",
                  source: { mode: "source", path: carrierDir },
                });
                if (res.status === "error") throw new Error(res.error);
              },
            );
            // History only; a failed commit must not undo a working install.
            await commitCarrier(carrierDir, changed).catch((err) =>
              log.warn("user-skills commit failed", { error: String(err) }),
            );
            return paths;
          });
        } catch (err) {
          const error = `Skill not saved: user-skills install failed, changes rolled back: ${err instanceof Error ? err.message : String(err)}`;
          runs.finish(runId, { status: "failed", error });
          log.error("user-skills install failed", { error });
          return { status: "error", error };
        }
      }

      runs.finish(runId, outcome);
      return {
        status: "ok",
        data: { runId, result: recorder.summary, ...(installed ? { installed } : {}) },
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
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
        // review's own agent session; keep to guardian chats. A chat is stored
        // either as a webchat row or as a webchat channel row addressed by its
        // own id.
        const row = appContext.db.connection.get(
          sql`
            SELECT id, name FROM rome_sessions
            WHERE (type IN ('webchat', 'webchat_handoff') OR (type = 'channel' AND source_channel = 'webchat' AND source_thread_id = id))
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
        return await review(sessionId as string, runId, recorder, runs);
      } finally {
        stopHeartbeat();
      }
    },
  };
}
