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
import { createRunsRepository } from "../../db/repositories/runs.js";
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

      // Open an independent session so this review does not pollute the main
      // agent's conversation history. The skill-review agent fetches its own
      // conversation history via get_webchat_conversations.
      // The heartbeat runs until the install finishes: waiting for the carrier
      // lock and installing are part of the run, not a stalled one.
      const stopHeartbeat = keepRunAlive(runs, runId);
      try {
        let before: Map<string, Buffer>;
        try {
          await ensureUserSkillsCarrier(carrierDir);
          before = await snapshotCarrierSkills(carrierDir);
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
          runs.finish(runId, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        if (recorder.error !== null) {
          runs.finish(runId, recorder.outcome());
          log.error("skill-review agent failed", { error: recorder.error });
          return { status: "error", error: `Skill-review agent failed: ${recorder.error}` };
        }

        // A saved SKILL.md is not a skill until the carrier listing it is
        // installed; register and install it here so the save is never silent.
        // Changes are found by diffing the carrier on disk, not by parsing tool
        // events, whose shape differs per provider (Codex edits carry no path).
        const changed = changedSkills(before, await snapshotCarrierSkills(carrierDir));
        let installed: string[] | undefined;
        if (changed.length > 0) {
          try {
            installed = await withCarrierLock(carrierDir, async () => {
              const appYaml = await readFile(join(carrierDir, "app.yaml"), "utf8");
              let skills: string[];
              try {
                skills = await registerCarrierSkills(carrierDir, changed);
                const res = await appContext.runAction("app_management", {
                  op: "install",
                  source: { mode: "source", path: carrierDir },
                });
                if (res.status === "error") throw new Error(res.error);
              } catch (err) {
                // One skill that can't build fails the whole carrier, so undo
                // this run's changes rather than break every later install.
                await restoreCarrier(carrierDir, appYaml, before, changed);
                throw err;
              }
              // History only; a failed commit must not undo a working install.
              await commitCarrier(carrierDir, changed).catch((err) =>
                log.warn("user-skills commit failed", { error: String(err) }),
              );
              return skills;
            });
          } catch (err) {
            const error = `Skill not saved: user-skills install failed, changes rolled back: ${err instanceof Error ? err.message : String(err)}`;
            runs.finish(runId, { status: "failed", error });
            log.error("user-skills install failed", { error });
            return { status: "error", error };
          }
        }

        runs.finish(runId, recorder.outcome());
        const result = recorder.summary;
        return { status: "ok", data: { runId, result, ...(installed ? { installed } : {}) } };
      } finally {
        stopHeartbeat();
      }
    },
  };
}
