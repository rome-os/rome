import { createAppLogger } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createScoutsRepository } from "../../db/repositories/scouts.js";
import { createScoutResultsRepository } from "../../db/repositories/scout-results.js";
import { unwrap, summonText } from "../../lib/action-result.js";

const log = createAppLogger("briefing_run_scout");

interface RunScoutInput {
  scoutId?: string;
  trigger?: string;
}

/** Sentinel the assistant returns when a run turned up nothing noteworthy. */
export const NO_FINDINGS_SENTINEL = "NO_FINDINGS";

function buildPrompt(title: string, prompt: string): string {
  return [
    `You are running a recurring scouting task for the guardian's briefing app. The task is titled "${title}".`,
    "",
    "Carry out the task below and report concise, factual findings in markdown. Lead with the single most important takeaway. Use short bullet points. Include links or sources when relevant. Do not pad. Return ONLY the findings — no preamble, no sign-off.",
    "",
    `If there is genuinely nothing new or noteworthy to report, reply with exactly \`${NO_FINDINGS_SENTINEL}\` and nothing else — do not fabricate or pad findings.`,
    "",
    "--- TASK ---",
    prompt,
  ].join("\n");
}

/** True when the assistant's reply is the no-findings sentinel (allowing minor decoration). */
export function isNoFindings(content: string): boolean {
  const normalized = content
    .trim()
    .replace(/^[`*_\s]+|[`*_.\s]+$/g, "")
    .toUpperCase();
  return normalized === NO_FINDINGS_SENTINEL || normalized === "NO FINDINGS";
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        scoutId: { type: "string", description: "The id of the scouting task to run" },
        trigger: {
          type: "string",
          description: 'How the run was started: "schedule" or "manual".',
        },
      },
      required: ["scoutId"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<ActionResult> => {
      const { scoutId, trigger } = input as RunScoutInput;
      if (typeof scoutId !== "string" || !scoutId) {
        return { status: "error", error: "scoutId is required." };
      }
      const scoutsRepo = createScoutsRepository(appContext.db);
      const scout = await scoutsRepo.byId(scoutId);
      if (!scout) {
        return { status: "error", error: `No scouting task with id ${scoutId}.` };
      }

      const resultsRepo = createScoutResultsRepository(appContext.db);
      const runTrigger = trigger === "manual" ? "manual" : "schedule";
      const resultId = await resultsRepo.start(scout.id, scout.title, runTrigger);
      await scoutsRepo.markRun(scout.id);

      let content = "";
      let errorMsg = "";
      try {
        const summoned = unwrap(
          await appContext.runAction("summon", {
            agentName: "assistant",
            prompt: buildPrompt(scout.title, scout.prompt),
          }),
        );
        if (summoned.ok) {
          content = summonText(summoned.data);
          if (!content) errorMsg = "The assistant returned no findings.";
        } else {
          errorMsg = summoned.error || "The assistant run failed.";
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      if (content && isNoFindings(content)) {
        // Nothing new — record the run as skipped so the history shows the
        // check happened, without feeding an empty finding into briefs.
        await resultsRepo.finish(resultId, { status: "skipped" });
        log.info("scout run skipped (no findings)", { scoutId: scout.id });
        return { status: "ok", data: { resultId, status: "skipped" } };
      }

      if (content) {
        await resultsRepo.finish(resultId, { status: "completed", content });
        log.info("scout run completed", { scoutId: scout.id, chars: content.length });
        return { status: "ok", data: { resultId, status: "completed", content } };
      }

      await resultsRepo.finish(resultId, { status: "failed", error: errorMsg });
      log.warn("scout run failed", { scoutId: scout.id, error: errorMsg });
      return { status: "error", error: errorMsg };
    },
  };
}
