import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AgentRunnerInterface,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createRunsRepository } from "../../db/repositories/runs.js";
import { hasChatSince } from "../../lib/chat-activity.js";
import { DREAM_WINDOW_HOURS } from "../../lib/dream-routine.js";
import { appChangesSince, snapshotApps } from "../../lib/app-changes.js";
import { RunRecorder, keepRunAlive } from "../../lib/run-recorder.js";
import {
  ensureUserSkillsCarrier,
  publishStagedSkills,
  snapshotCarrierSkills,
  stageCarrierSkills,
  userSkillsCarrierDir,
} from "../../lib/user-skills-carrier.js";

const log = createAppLogger("dream");

export interface DreamDeps {
  agentRunner: AgentRunnerInterface;
  /** The user-skills carrier the dream's skills install into. Tests point it at a temp dir. */
  carrierDir?: string;
  /** The profile's memory directory. Tests point it at a fixed path. */
  memoryDir?: string;
}

/** Core's profile memory directory (`getProfileMemoryDir`), which an app cannot import. */
function profileMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), ".rome", env.ROME_PROFILE || "default", "memory");
}

/** Appends the practice agent's notes to the journal, and records it on the run. */
async function appendPracticeNotes(
  notesPath: string,
  journalPath: string,
  runs: ReturnType<typeof createRunsRepository>,
  runId: string,
): Promise<void> {
  const notes = (await readFile(notesPath, "utf8").catch(() => "")).trim();
  if (!notes) return;
  const text = `\n\n${notes}\n`;
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(journalPath, text);
  runs.addChanges(runId, [
    { op: "edit", path: journalPath, content: text, previous: "", truncated: false },
  ]);
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps<DreamDeps>): Action {
  const { agentRunner, appContext } = deps;
  const carrierDir = deps.carrierDir ?? userSkillsCarrierDir();
  const memoryDir = deps.memoryDir ?? profileMemoryDir();

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        windowHours: {
          type: "number",
          description: `How many hours of history to review (default: ${DREAM_WINDOW_HOURS})`,
        },
        runId: {
          type: "string",
          description:
            "Run record to report into, created by the Dream page before it starts the run. Omit to create one.",
        },
      },
      required: [],
    },

    async execute(args): Promise<ActionResult> {
      const windowHours = (args.windowHours as number | undefined) ?? DREAM_WINDOW_HOURS;
      // A guardian who presses "Dream now" asked for this run, so only callers
      // without a reserved run (the routine) need a conversation to review.
      // Checking before the reservation keeps an idle stretch out of the run
      // list.
      if (
        typeof args.runId !== "string" &&
        !hasChatSince(appContext.db, new Date(Date.now() - windowHours * 60 * 60 * 1000))
      ) {
        log.info("dream skipped, no chat in window", { windowHours });
        return {
          status: "ok",
          data: { windowHours, skipped: true, reason: "no_recent_chat", summary: "" },
        };
      }
      const runs = createRunsRepository(appContext.db);
      // The page reserves a queued run and passes its id, and claiming it is
      // what makes this the one execution that works on it. Any other caller
      // reserves its own run. Either way a dream that overlaps another stands
      // down: two agents editing the same memory and journal would overwrite
      // each other.
      const reservation =
        typeof args.runId === "string"
          ? { id: args.runId, reserved: runs.claim(args.runId) }
          : runs.reserveDream(windowHours, "running");
      if (!reservation.reserved) {
        log.info("dream skipped, another dream has this run", { runId: reservation.id });
        return {
          status: "ok",
          data: {
            runId: reservation.id,
            windowHours,
            skipped: true,
            reason: "already_running",
            summary: "",
          },
        };
      }
      const runId = reservation.id;

      log.info("dream started", { windowHours, runId });

      /** Runs one agent into the run record. Null when it completed. */
      async function runAgent(
        agentName: string,
        prompt: string,
        recorder: RunRecorder,
      ): Promise<ActionResult | null> {
        try {
          for await (const msg of agentRunner.run({ agentName, prompt })) {
            recorder.observe(msg);
          }
        } catch (err) {
          runs.finish(runId, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        const outcome = recorder.outcome();
        if (outcome.status === "completed") return null;
        runs.finish(runId, outcome);
        if (recorder.error !== null) {
          log.error("dream agent failed", { agentName, error: recorder.error });
          return { status: "error", error: `Dream agent failed: ${recorder.error}` };
        }
        return { status: "ok", data: { runId, windowHours, summary: recorder.summary } };
      }

      // The practice agent saves skills into a private copy of the carrier,
      // and only a dream that completes installs them.
      const stopHeartbeat = keepRunAlive(runs, runId);
      let staging: string | undefined;
      try {
        let before: Map<string, Buffer>;
        try {
          await ensureUserSkillsCarrier(carrierDir);
          staging = await stageCarrierSkills(carrierDir);
          before = await snapshotCarrierSkills(staging);
        } catch (err) {
          const error = `Could not stage the user-skills carrier: ${err instanceof Error ? err.message : String(err)}`;
          runs.finish(runId, { status: "failed", error });
          log.error("dream failed to stage skills", { error, runId });
          return { status: "error", error };
        }

        const now = new Date();
        const journalPath = join(
          memoryDir,
          "journal",
          String(now.getUTCFullYear()),
          String(now.getUTCMonth() + 1).padStart(2, "0"),
          `${String(now.getUTCDate()).padStart(2, "0")}.md`,
        );
        const appsDir = dirname(carrierDir);

        // Two agents, so the one that can run code never reads what other
        // people wrote on Rome's accounts. The memory agent reads every source
        // with file tools only. The practice agent reads the guardian's own
        // chats and the action logs, and can change apps.
        const memoryRecorder = new RunRecorder(runs, runId);
        const memoryPrompt = [
          `Today is ${now.toISOString()}. Dream over the past ${windowHours} hours.`,
          "",
          `- Window: pass windowHours: ${windowHours} to get_webchat_conversations, get_account_chats, and get_action_logs.`,
          `- Memory directory: ${memoryDir}`,
          `- Today's journal entry: ${journalPath}`,
        ].join("\n");
        const memoryStopped = await runAgent("dream", memoryPrompt, memoryRecorder);
        if (memoryStopped) return memoryStopped;

        const practiceRecorder = new RunRecorder(runs, runId);
        // The practice agent gets no memory or journal path: the memory agent
        // just wrote those from other people's chats. Its notes go to a file
        // of its own, which the action appends to the journal.
        const notesPath = join(staging, "practice.md");
        const practicePrompt = [
          `Today is ${now.toISOString()}. Practice over the past ${windowHours} hours.`,
          "",
          `- Window: pass windowHours: ${windowHours} to get_webchat_conversations and get_action_logs.`,
          `- Skills staging directory: ${join(staging, "skills")}`,
          `- Guardian's apps directory: ${appsDir}`,
          `- Practice notes file: ${notesPath}`,
        ].join("\n");
        const appsBefore = await snapshotApps(appsDir);
        let practiceStopped: ActionResult | null;
        try {
          practiceStopped = await runAgent("dream-practice", practicePrompt, practiceRecorder);
        } finally {
          // App changes are live once made, so record them even from a run
          // that failed, for the guardian to review.
          runs.addChanges(
            runId,
            await appChangesSince(appsDir, appsBefore, practiceRecorder.paths),
          );
          await appendPracticeNotes(notesPath, journalPath, runs, runId);
        }
        if (practiceStopped) return practiceStopped;
        const agentSummary = [memoryRecorder.summary, practiceRecorder.summary]
          .filter(Boolean)
          .join("\n\n");

        // Memory is already written, so a skill that fails to install is
        // reported with the dream rather than failing it.
        let installed: string[] = [];
        let skillsError: string | undefined;
        try {
          installed = await publishStagedSkills(
            carrierDir,
            staging,
            before,
            async () => {
              const res = await appContext.runAction("app_management", {
                op: "install",
                source: { mode: "source", path: carrierDir },
              });
              if (res.status === "error") throw new Error(res.error);
            },
            (err) => log.warn("user-skills commit failed", { error: String(err) }),
          );
        } catch (err) {
          skillsError = `Skills not saved: user-skills install failed, changes rolled back: ${err instanceof Error ? err.message : String(err)}`;
          log.error("user-skills install failed", { error: skillsError, runId });
        }
        const summary = skillsError ? `${agentSummary}\n\n${skillsError}` : agentSummary;
        runs.finish(runId, { status: "completed", summary });
        log.info("dream completed", { runId, installed, resultLength: summary.length });

        return {
          status: "ok",
          data: {
            runId,
            windowHours,
            summary,
            ...(installed.length > 0 ? { installed } : {}),
            ...(skillsError ? { skillsError } : {}),
          },
        };
      } finally {
        stopHeartbeat();
        if (staging) await rm(staging, { recursive: true, force: true });
      }
    },
  };
}
