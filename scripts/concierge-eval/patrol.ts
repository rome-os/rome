// pnpm concierge:eval --patrol — plays the patrol's scenarios against the
// patrol agent itself, with no stack: code's holds, the agent's prompt and
// answer shape from packages/core, and the agent through the Claude Code CLI
// on the host. Reports precision and recall together. docs/concierge-eval.md#patrol

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readPatrolAgentFile } from "../../packages/core/src/concierge/patrol/agent-file.js";
import type { Observation } from "../../packages/core/src/db/repositories/concierge-observations.js";
import {
  buildPatrolPrompt,
  type PatrolObservationView,
  parsePatrolOutput,
  speechHold,
} from "../../packages/core/src/concierge/patrol/brief.js";
import { guardianNow } from "../../packages/core/src/concierge/alerts.js";
import {
  HOUR_MS,
  holdReason,
  nextSpeakingRun,
} from "../../packages/core/src/concierge/patrol/volume.js";
import {
  PATROL_NOW,
  PATROL_SCENARIOS,
  PATROL_SCENARIOS_VERSION,
  PATROL_ZONE,
  type PatrolScenario,
} from "./patrol-scenarios.js";
import { judgeRun, type PatrolRun, patrolMarkdown, summarize } from "./patrol-score.js";

const USAGE = `pnpm concierge:eval --patrol --label <name> [--rounds N] [--model <id>] [--concurrency N] [--only id,id]

Options:
  --model <id>         the patrol's model (default claude-sonnet-5-5, the medium tier on Claude)
  --rounds N           runs of each scenario (default 3)
  --concurrency N      scenarios played at once (default 3)
  --out <dir>          results folder (default .concierge-eval/patrol)`;

const { values: args } = parseArgs({
  options: {
    patrol: { type: "boolean" },
    label: { type: "string" },
    rounds: { type: "string", default: "3" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    concurrency: { type: "string", default: "3" },
    only: { type: "string" },
    out: { type: "string", default: ".concierge-eval/patrol" },
    help: { type: "boolean" },
  },
});

if (args.help || !args.label) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}
if (!/^claude-/.test(args.model)) {
  console.error("The patrol eval runs Claude models only.");
  process.exit(1);
}

const DIGEST_TIMES = ["09:00", "18:00"];

const agent = readPatrolAgentFile();

/** The observations a scenario holds, as the store would. */
function storedOf(view: PatrolObservationView): Observation {
  const told = view.lastTold ? Date.parse(view.lastTold) : null;
  return {
    id: view.topicKey,
    ownerKey: "guardian",
    topicKey: view.topicKey,
    kind: view.kind,
    source: view.source,
    basis: view.basis,
    confidence: view.confidence,
    status: view.status,
    summary: view.summary,
    taskId: view.taskId ?? null,
    dueAt: view.due ? new Date(view.due) : null,
    expiresAt: new Date(PATROL_NOW + 7 * 24 * HOUR_MS),
    outcomes: told === null ? [] : [{ outcome: "told", at: told }],
    toldCount: view.toldCount,
    ignoredCount: 0,
    lastToldAt: told === null ? null : new Date(told),
    createdAt: new Date(PATROL_NOW - 7 * 24 * HOUR_MS),
    updatedAt: new Date(PATROL_NOW),
  };
}

/** Runs the patrol agent once through the CLI, in an empty folder with no user settings. */
function callAgent(prompt: string): Promise<{ output: unknown; costUsd: number }> {
  const cwd = mkdtempSync(join(tmpdir(), "rome-patrol-eval-"));
  const cliArgs = [
    "-p",
    "--model",
    args.model,
    // Only this folder's settings, which hold nothing: no user CLAUDE.md sways the run.
    "--setting-sources",
    "project",
    "--system-prompt",
    agent.systemPromptPrefix,
    "--json-schema",
    JSON.stringify(agent.outputSchema),
    "--tools",
    "",
    "--output-format",
    "json",
    "--max-turns",
    "4",
  ];
  return new Promise<{ output: unknown; costUsd: number }>((resolve, reject) => {
    const child = execFile(
      "claude",
      cliArgs,
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          const parsed = JSON.parse(stdout) as {
            structured_output?: unknown;
            total_cost_usd?: number;
            is_error?: boolean;
            result?: string;
          };
          if (parsed.is_error || parsed.structured_output === undefined) {
            return reject(
              new Error(`no structured answer: ${String(parsed.result).slice(0, 200)}`),
            );
          }
          resolve({ output: parsed.structured_output, costUsd: parsed.total_cost_usd ?? 0 });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    child.stdin?.end(prompt);
  }).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

async function play(scenario: PatrolScenario, round: number): Promise<PatrolRun> {
  const now = scenario.hold?.now ?? PATROL_NOW;
  const base: PatrolRun = {
    id: scenario.id,
    group: scenario.group,
    round,
    hold: null,
    chose: false,
    spoke: false,
    topicKey: null,
    line: null,
    offerStart: false,
    reason: "",
    ms: 0,
    costUsd: 0,
  };
  const hold = holdReason({
    now,
    timeZone: PATROL_ZONE,
    quietHours: null,
    digestTimes: DIGEST_TIMES,
    toldToday: 0,
    lastRunAt: null,
    lastOwnerMessageAt: now - HOUR_MS,
    intervalMs: 3 * HOUR_MS,
    recheck: false,
    ...scenario.hold,
  });
  // Code holds it before any model runs, as the patrol does.
  if (hold) return { ...base, hold, reason: "held before the run" };
  const started = Date.now();
  try {
    const next = nextSpeakingRun(now, 3 * HOUR_MS, null, DIGEST_TIMES, PATROL_ZONE);
    const { output, costUsd } = await callAgent(
      buildPatrolPrompt({
        ...scenario.input,
        nextRun: next === null ? null : guardianNow(next, PATROL_ZONE),
      }),
    );
    const parsed = parsePatrolOutput(output, {
      now,
      taskIds: new Set(scenario.input.tasks.map((task) => task.id)),
      calendar: scenario.input.calendar ?? [],
    });
    // The store after the run: what it held, with what the run wrote on top.
    const stored = new Map(scenario.input.observations.map((o) => [o.topicKey, storedOf(o)]));
    for (const draft of parsed.observations) {
      const before = stored.get(draft.topicKey);
      stored.set(
        draft.topicKey,
        before
          ? { ...before, ...draft }
          : {
              id: draft.topicKey,
              ownerKey: "guardian",
              ...draft,
              outcomes: [],
              toldCount: 0,
              ignoredCount: 0,
              lastToldAt: null,
              createdAt: new Date(now),
              updatedAt: new Date(now),
            },
      );
    }
    const codeHold = speechHold(parsed.speak, [...stored.values()], {
      now,
      messagesLeftToday: scenario.input.messagesLeftToday,
      taskUpdatedAt: () => null,
    });
    return {
      ...base,
      hold: codeHold,
      chose: parsed.speak !== null,
      spoke: parsed.speak !== null && codeHold === null,
      topicKey: parsed.speak?.topicKey ?? null,
      line: parsed.speak?.line ?? null,
      offerStart: parsed.speak?.offerStart ?? false,
      reason: parsed.reason,
      ms: Date.now() - started,
      costUsd,
    };
  } catch (error) {
    return {
      ...base,
      ms: Date.now() - started,
      reason: "the run failed: silent",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const only = args.only ? new Set(args.only.split(",")) : null;
  const scenarios = PATROL_SCENARIOS.filter((s) => !only || only.has(s.id));
  const rounds = Math.max(1, Number(args.rounds) || 1);
  const jobs = Array.from({ length: rounds }, (_, i) =>
    scenarios.map((s) => [s, i + 1] as const),
  ).flat();
  const runs: PatrolRun[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [scenario, round] = jobs[next++]!;
      const run = await play(scenario, round);
      runs.push(run);
      console.log(
        `${scenario.id} r${round}: ${run.spoke ? "spoke" : "silent"}${run.hold ? ` (held: ${run.hold})` : ""}${run.error ? ` error: ${run.error}` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 1) }, worker));
  const byId = new Map(PATROL_SCENARIOS.map((s) => [s.id, s]));
  const verdicts = runs
    .sort((a, b) => a.id.localeCompare(b.id) || a.round - b.round)
    .map((run) => judgeRun(byId.get(run.id)!, run));
  const dir = join(args.out, args.label!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "runs.json"),
    JSON.stringify(
      { model: args.model, scenariosVersion: PATROL_SCENARIOS_VERSION, verdicts },
      null,
      2,
    ),
  );
  const report = patrolMarkdown(args.label!, args.model, verdicts);
  writeFileSync(join(dir, "summary.md"), report);
  console.log(`\n${report}`);
  const all = summarize(verdicts);
  console.log(JSON.stringify(all));
}

/** Plays the scenarios, as `pnpm concierge:eval --patrol` asks. */
export const patrolEval = main;
