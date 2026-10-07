import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AgentRunnerInterface,
  type AppActionRuntimeDeps,
  type Routine,
} from "@rome-os/app-runtime";
import { createRunsRepository } from "../../db/repositories/runs.js";
import { RunRecorder, keepRunAlive } from "../../lib/run-recorder.js";

const log = createAppLogger("dream");

const DREAM_EVENT_NAME = "daily-dream";
const DEFAULT_REVIEW_TIME = "03:00";
const DEFAULT_REVIEW_TZ = "UTC";
const DAILY_RRULE = "FREQ=DAILY";

export interface DreamDeps {
  agentRunner: AgentRunnerInterface;
}

async function ensureDailySchedule(
  runAction: (name: string, args: Record<string, unknown>) => Promise<ActionResult>,
  listRoutines: () => Promise<Routine[]>,
): Promise<void> {
  const existing = await listRoutines();
  // Dedup on the routine name alone. Matching on actionName too would let any
  // unrelated routine that happens to run `dream` suppress this required daily
  // self-register.
  const alreadyScheduled = existing.some((r) => r.name === DREAM_EVENT_NAME);

  if (alreadyScheduled) {
    return;
  }

  log.info("no daily dream routine found, registering one now");

  // create_routine reports caller-fixable problems via { status: "error" },
  // not a throw — surface that so a failed registration isn't mistaken for a
  // scheduled routine.
  // This required daily self-review is auto-attributed to dream by the runtime
  // (create_routine reads the calling app), so it isn't the user's to delete —
  // dream re-registers it if missing.
  const result = await runAction("create_routine", {
    name: DREAM_EVENT_NAME,
    trigger: {
      type: "schedule",
      tzid: DEFAULT_REVIEW_TZ,
      // Floating: the nightly review runs at the guardian's local 03:00 and
      // follows them if they move.
      tzMode: "floating",
      localTime: DEFAULT_REVIEW_TIME,
      rrule: DAILY_RRULE,
    },
    actionName: "dream",
    args: {},
  });
  if (result.status === "error") {
    throw new Error(`create_routine failed: ${result.error}`);
  }

  log.info("daily dream event registered", {
    time: DEFAULT_REVIEW_TIME,
    tz: DEFAULT_REVIEW_TZ,
    rrule: DAILY_RRULE,
  });
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps<DreamDeps>): Action {
  const { agentRunner, appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        windowHours: {
          type: "number",
          description: "How many hours of history to review (default: 24)",
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
      const windowHours = (args.windowHours as number | undefined) ?? 24;
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
          data: { runId: reservation.id, windowHours, skipped: true, summary: "" },
        };
      }
      const runId = reservation.id;
      const recorder = new RunRecorder(runs, runId);

      log.info("dream started", { windowHours, runId });

      // Make sure daily schedule is registered on first run
      try {
        await ensureDailySchedule(
          appContext.runAction.bind(appContext),
          appContext.listRoutines.bind(appContext),
        );
      } catch (err) {
        log.warn("failed to auto-register daily schedule (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const now = new Date();
      const prompt = [
        `Today is ${now.toISOString()}. Perform the scheduled self-review for the past ${windowHours} hours.`,
        "",
        "Follow the review process in your instructions:",
        `1. Read memory/MEMORY.md`,
        `2. Call get_webchat_conversations (windowHours: ${windowHours}) to fetch recent conversations`,
        `3. Call fetch_channel_history (channel: "discord", windowHours: ${windowHours}) to fetch recent Discord messages`,
        `4. Call get_action_logs (windowHours: ${windowHours}) to fetch recent action executions`,
        `5. Synthesize all sources into insights and updates`,
        `6. Update memory files as needed`,
        `7. Write today's journal entry at memory/journal/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}.md`,
      ].join("\n");

      let turnCount = 0;

      const stopHeartbeat = keepRunAlive(runs, runId);
      try {
        for await (const msg of agentRunner.run({
          agentName: "dream",
          prompt,
        })) {
          recorder.observe(msg);
          if (msg.type === "text") turnCount++;
        }
      } catch (err) {
        runs.finish(runId, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        stopHeartbeat();
      }

      runs.finish(runId, recorder.outcome());
      if (recorder.error !== null) {
        log.error("dream agent failed", { error: recorder.error });
        return { status: "error", error: `Dream agent failed: ${recorder.error}` };
      }
      const resultContent = recorder.summary;
      log.info("dream completed", { turnCount, resultLength: resultContent.length, runId });

      return {
        status: "ok",
        data: {
          runId,
          windowHours,
          summary: resultContent,
        },
      };
    },
  };
}
