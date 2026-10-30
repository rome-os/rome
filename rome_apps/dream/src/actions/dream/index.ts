import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
import { appChangesSince, attributeAppChanges, snapshotApps } from "../../lib/app-changes.js";
import { profileMemoryDir } from "../../lib/memory-dir.js";
import { type FileChange, MAX_CHANGE_CHARS } from "../../lib/changes.js";
import { RunRecorder, keepRunAlive } from "../../lib/run-recorder.js";
import {
  ensureUserSkillsCarrier,
  publishStagedSkills,
  removeStaleRunFolders,
  snapshotCarrierSkills,
  stageCarrierSkills,
  stagingParent,
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

/** The installed skills a dream added or changed, as writes or as edits of their old text. */
async function installedSkillChanges(
  carrierDir: string,
  installed: string[],
  before: Map<string, Buffer>,
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  for (const entry of installed) {
    const path = join(carrierDir, entry, "SKILL.md");
    const content = await readFile(path, "utf8").catch(() => null);
    if (content === null) continue;
    const previous = before.get(basename(entry))?.toString("utf8") ?? null;
    changes.push({
      op: previous === null ? "write" : "edit",
      path,
      content: content.slice(0, MAX_CHANGE_CHARS),
      previous: previous?.slice(0, MAX_CHANGE_CHARS) ?? null,
      truncated: content.length > MAX_CHANGE_CHARS || (previous?.length ?? 0) > MAX_CHANGE_CHARS,
      attribution: "practice",
    });
  }
  return changes;
}

/** The OS temp folders that hold a dream's pre-run copy of the apps. */
const APP_SNAPSHOT_PREFIX = "dream-apps-";

/** One run's notes are a few lines; a cap keeps ten of them small in a prompt. */
const MAX_NOTES_CHARS = 4_000;

/** How many earlier runs' practice notes the practice agent sees. */
const EARLIER_PRACTICE_RUNS = 10;

/**
 * Appends the practice agent's notes to the journal, and records them on the
 * run, where the next runs' practice prompts read them back from.
 */
async function savePracticeNotes(
  notesPath: string,
  journalPath: string,
  runs: ReturnType<typeof createRunsRepository>,
  runId: string,
): Promise<void> {
  const notes = (await readFile(notesPath, "utf8").catch(() => ""))
    .trim()
    .slice(0, MAX_NOTES_CHARS);
  if (!notes) return;
  const text = `\n\n${notes}\n`;
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(journalPath, text);
  // An edit with no previous text marks these as practice notes: an agent's
  // Edit always records the text it replaced, even when that is empty.
  runs.addChanges(runId, [
    { op: "edit", path: journalPath, content: text, previous: null, truncated: false },
  ]);
}

/** Earlier runs' practice notes, read from the run records rather than a file any agent can write. */
function earlierPracticeNotes(
  runs: ReturnType<typeof createRunsRepository>,
  memoryDir: string,
  runId: string,
): string {
  const notes = runs.practiceNotes(memoryDir, EARLIER_PRACTICE_RUNS, runId);
  if (notes.length === 0) return "(None yet.)";
  return notes
    .map(({ startedAt, content }) => `### Run of ${startedAt.toISOString()}\n\n${content.trim()}`)
    .join("\n\n");
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
        label: string,
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
            error: `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          throw err;
        }
        const outcome = recorder.outcome();
        if (outcome.status === "completed") return null;
        const error = `${label} failed: ${recorder.error}`;
        runs.finish(runId, outcome.status === "failed" ? { status: "failed", error } : outcome);
        if (recorder.error !== null) {
          log.error("dream agent failed", { agentName, error: recorder.error });
          return { status: "error", error };
        }
        return { status: "ok", data: { runId, windowHours, summary: recorder.summary } };
      }

      // The practice agent saves skills into a private copy of the carrier,
      // and only a dream that completes installs them.
      const stopHeartbeat = keepRunAlive(runs, runId);
      let staging: string | undefined;
      let appsCopy: string | undefined;
      try {
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
        // and can write only memory, through actions that refuse any other
        // path. The practice agent reads the guardian's own chats and the
        // action logs, and can change apps.
        const memoryRecorder = new RunRecorder(runs, runId);
        const memoryPrompt = [
          `Today is ${now.toISOString()}. Dream over the past ${windowHours} hours.`,
          "",
          `- Window: pass windowHours: ${windowHours} to get_webchat_conversations, get_account_chats, and get_action_logs.`,
          `- Memory directory: ${memoryDir}`,
          `- Today's journal entry: ${journalPath}`,
        ].join("\n");
        const memoryStopped = await runAgent("dream", "Memory agent", memoryPrompt, memoryRecorder);
        if (memoryStopped) return memoryStopped;

        // The practice agent's skills staging copy, and its baseline for the
        // apps diff: a copy of the apps outside staging, taken after the
        // carrier exists so a fresh carrier does not show as an app change.
        let before: Map<string, Buffer>;
        let appsBefore: Awaited<ReturnType<typeof snapshotApps>>;
        try {
          await ensureUserSkillsCarrier(carrierDir);
          await removeStaleRunFolders(stagingParent(carrierDir));
          await removeStaleRunFolders(tmpdir(), APP_SNAPSHOT_PREFIX);
          staging = await stageCarrierSkills(carrierDir);
          before = await snapshotCarrierSkills(staging);
          appsCopy = await mkdtemp(join(tmpdir(), APP_SNAPSHOT_PREFIX));
          appsBefore = await snapshotApps(appsDir, appsCopy);
        } catch (err) {
          const error = `Could not prepare the practice run: ${err instanceof Error ? err.message : String(err)}`;
          runs.finish(runId, { status: "failed", error });
          log.error("dream failed to prepare practice", { error, runId });
          return { status: "error", error };
        }

        // The apps diff below is the authoritative record of the practice
        // agent's app changes (staging included), so its file-tool calls there
        // are not recorded twice.
        const practiceRecorder = new RunRecorder(runs, runId, appsDir);
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
          "",
          "## Your notes from earlier runs",
          "",
          earlierPracticeNotes(runs, memoryDir, runId),
        ].join("\n");
        let practiceStopped: ActionResult | null;
        try {
          practiceStopped = await runAgent(
            "dream-practice",
            "Practice agent (after memory was updated)",
            practicePrompt,
            practiceRecorder,
          );
        } finally {
          // App changes are live once made, so record them even from a run
          // that failed. Only paths observed in practice tool calls are attributed.
          try {
            const changes = await appChangesSince(appsDir, appsBefore);
            runs.addChanges(runId, attributeAppChanges(changes, practiceRecorder.knownPaths()));
            await savePracticeNotes(notesPath, journalPath, runs, runId);
          } catch (err) {
            log.error("dream failed to record practice changes", { error: String(err), runId });
          }
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
          // However the agent wrote them, the installed skills are what the
          // guardian reviews, against what they said before this dream.
          runs.addChanges(runId, await installedSkillChanges(carrierDir, installed, before));
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
        if (appsCopy) await rm(appsCopy, { recursive: true, force: true });
      }
    },
  };
}
