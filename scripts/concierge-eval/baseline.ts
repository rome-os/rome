// pnpm concierge:baseline — times the Concierge and scores its answers on the
// baseline scenarios, for one model and effort per run, so configurations can
// be compared on latency and quality. docs/concierge-eval.md#baseline

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Api, type ChatMessage, DEV_JWT_SECRET, partsOf } from "./api.js";
import {
  BASELINE_SCENARIOS,
  BASELINE_VERSION,
  type BaselineScenario,
  type CheckInput,
} from "./baseline-scenarios.js";
import { baselineMarkdown, type ScenarioRun } from "./baseline-report.js";
import { drive } from "./drive.js";
import { judge, type Verdict } from "./judge.js";
import { Stack, checkSnapshotName, sleep } from "./stack.js";
import { type TaskPath, readSpans, taskPath } from "./task-path.js";
import { type TimedTurn, timedTurns } from "./timing.js";

const USAGE = `pnpm concierge:baseline --config <label> --model <selection id> --effort <low|high> [--runs N]
pnpm concierge:baseline --report
pnpm concierge:baseline --rejudge id,id   score the saved runs of these scenarios again, by their current rubric

Options:
  --only id,id         play some scenarios only
  --concurrency N      scenarios played at once (default 1: timings stay clean)
  --name <snapshot>    restore this snapshot before each run (pnpm concierge:eval --snapshot)
  --no-restore         keep the stack as it is between runs
  --no-judge           skip the judge's scores
  --judge-model <m>    the judge's model (default claude-opus-5-5) at --judge-effort (default high)
  --container, --base-url, --user, --out, --timeout: as pnpm concierge:eval`;

const SLUG = execFileSync("bash", [join("scripts", "worktree-slug.sh")], {
  encoding: "utf8",
}).trim();

const { values: args } = parseArgs({
  options: {
    config: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    concurrency: { type: "string", default: "1" },
    name: { type: "string", default: "frozen" },
    "no-restore": { type: "boolean" },
    "no-judge": { type: "boolean" },
    "judge-model": { type: "string", default: "claude-opus-5-5" },
    "judge-effort": { type: "string", default: "high" },
    report: { type: "boolean" },
    rejudge: { type: "string" },
    container: { type: "string", default: `${SLUG}-rome-1` },
    "base-url": {
      type: "string",
      default: process.env.ROME_URL ?? `http://${SLUG}.rome.localhost:3000`,
    },
    user: { type: "string", default: "dev" },
    out: { type: "string", default: ".concierge-eval/baseline" },
    timeout: { type: "string", default: "25" },
    obs: {
      type: "string",
      default: process.env.ROME_OBS_QUERY_URL ?? "http://clickhouse.rome.localhost:3000",
    },
    help: { type: "boolean" },
  },
});

const stack = new Stack({ container: args.container, baseUrl: args["base-url"] });

/** The text parts of a message, joined. */
function textOf(message: ChatMessage): string {
  return partsOf(message)
    .filter((p) => p.type === "text")
    .map((p) => String(p.content ?? p.text ?? ""))
    .join("\n")
    .trim();
}

const isOwner = (m: ChatMessage) =>
  m.role === "user" && partsOf(m).some((p) => p.type === "text") && textOf(m) !== "";

function logsSince(sinceIso: string): string {
  return execFileSync("docker", ["logs", "--since", sinceIso, args.container], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Where a turn's first message landed, epoch ms, from its log line's time. */
const firstSayAt = (t: TimedTurn) =>
  t.firstSayMs === null ? null : Date.parse(t.at) - t.durationMs + t.firstSayMs;

async function playScenario(
  api: Api,
  scenario: BaselineScenario,
  run: number,
): Promise<ScenarioRun> {
  const config = args.config as string;
  const log = (line: string) => console.log(`[${config} r${run} ${scenario.id}] ${line}`);
  const chat = await api.createTopicChat(`baseline ${config} r${run} ${scenario.id}`);
  await api.setModel(chat.id, args.model as string);
  log(`chat ${chat.id}`);
  // From here the owner sends: the chat's setup is no time they wait.
  const startedAtIso = new Date(Date.now() - 1000).toISOString();
  const startedAt = Date.now();
  let failure: string | null = null;
  const driven = await drive(
    api,
    chat.id,
    {
      id: scenario.id,
      about: scenario.about,
      steps: scenario.steps,
      cards: "first",
      approvals: "approve",
      expect: { endReason: "done" },
    },
    {
      settleMs: 20_000,
      timeoutMs: Number(args.timeout) * 60_000,
      pollMs: 1000,
      log,
      effort: args.effort,
    },
  ).catch((error: unknown) => {
    failure = error instanceof Error ? error.message : String(error);
    log(`failed: ${failure}`);
    return { outcomes: [], tasks: [], timedOut: true };
  });
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  // The last turn's log line follows its end by a moment.
  await sleep(1500);
  const turns = timedTurns(logsSince(startedAtIso)).filter((t) => t.chatId === chat.id);
  const messages = await api.messages(chat.id);

  // The Concierge's text messages after each owner message.
  const saidAfter: string[][] = [];
  const transcript: string[] = [];
  for (const m of messages) {
    if (isOwner(m)) {
      saidAfter.push([]);
      transcript.push(`OWNER: ${textOf(m)}`);
    } else if (m.role === "assistant") {
      const text = textOf(m);
      if (!text) continue;
      saidAfter.at(-1)?.push(text);
      transcript.push(`ASSISTANT: ${text}`);
    }
  }
  const guardian = turns.filter((t) => t.trigger === "guardian");
  const input: CheckInput = {
    steps: scenario.steps.map((_, i) => guardian[i] ?? null),
    turns,
    saidAfter,
    said: saidAfter.flat(),
    tasks: driven.tasks,
  };
  const notes = scenario.check(input);
  if (driven.timedOut) notes.push("timed out before the chat was quiet");
  if (failure) notes.push(`the driver failed: ${failure}`);

  // The owner waits from the send for the relayed result of a task.
  const relayed = turns
    .filter((t) => t.trigger === "system")
    .map(firstSayAt)
    .filter((at): at is number => at !== null);
  const resultMs = relayed.length ? Math.max(...relayed) - startedAt : null;

  let verdict: Verdict | null = null;
  if (!args["no-judge"]) {
    verdict = await judge(scenario.rubric, transcript.join("\n\n"), {
      model: args["judge-model"] as string,
      effort: args["judge-effort"] as string,
    }).catch((error: unknown) => {
      log(`judge failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  // A delegated task's time, split by where it went, from the stack's traces.
  let path: TaskPath | null = null;
  if (turns.some((t) => (t.tools.chat_start ?? 0) > 0)) {
    path = await taskPathOf(chat.id, startedAt, startedAtIso).catch((error: unknown) => {
      log(`task path failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  log(`checks ${notes.length ? notes.join("; ") : "ok"}; score ${verdict?.score ?? "-"}`);
  return {
    id: scenario.id,
    row: scenario.row,
    config,
    model: args.model as string,
    effort: args.effort as string,
    run,
    chatId: chat.id,
    seconds,
    resultMs,
    turns,
    notes,
    verdict,
    transcript,
    taskPath: path,
  };
}

/** The breakdown of the chat's first task, once its traces reached rome-obs. */
async function taskPathOf(
  chatId: string,
  sentAt: number,
  sinceIso: string,
): Promise<TaskPath | null> {
  const [tasks] = stack.query<{ session_id: string }>([
    {
      sql: "SELECT session_id FROM concierge_tasks WHERE chat_id = ? AND session_id IS NOT NULL ORDER BY created_at",
      params: [chatId],
    },
  ]);
  const task = tasks?.[0]?.session_id;
  if (!task) return null;
  // Spans are exported in batches.
  await sleep(10_000);
  const rows = await readSpans(args.obs as string, [chatId, task], sinceIso);
  return taskPath(rows, chatId, task, sentAt);
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, size) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

function readRuns(): ScenarioRun[] {
  if (!existsSync(args.out)) return [];
  const runs: ScenarioRun[] = [];
  for (const config of readdirSync(args.out)) {
    const dir = join(args.out, config);
    if (!config.match(/^[\w.-]+$/) || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f))) {
      const saved = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        version?: number;
        scenarios: ScenarioRun[];
      };
      // Each run keeps the scenario version it was played at, so the report
      // never pools runs of a scenario that changed in between.
      runs.push(...saved.scenarios.map((s) => ({ ...s, version: saved.version ?? 1 })));
    }
  }
  return runs;
}

/** Scores the saved runs of `ids` again, by their scenarios' current rubric. */
async function rejudge(ids: string[]): Promise<void> {
  for (const config of readdirSync(args.out)) {
    const dir = join(args.out, config);
    if (!/^[\w.-]+$/.test(config) || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f))) {
      const path = join(dir, file);
      const saved = JSON.parse(readFileSync(path, "utf8")) as { scenarios: ScenarioRun[] };
      for (const run of saved.scenarios.filter((r) => ids.includes(r.id))) {
        const scenario = BASELINE_SCENARIOS.find((s) => s.id === run.id);
        if (!scenario) continue;
        run.verdict = await judge(scenario.rubric, run.transcript.join("\n\n"), {
          model: args["judge-model"] as string,
          effort: args["judge-effort"] as string,
        }).catch((error: unknown) => {
          // A failed judge keeps the score the run had.
          console.warn(
            `${config} ${file} ${run.id}: judge failed, score kept: ${error instanceof Error ? error.message : String(error)}`,
          );
          return run.verdict;
        });
        console.log(`${config} ${file} ${run.id}: ${run.verdict?.score ?? "-"}`);
      }
      writeFileSync(path, JSON.stringify(saved, null, 2));
    }
  }
  writeReport();
}

function writeReport(): void {
  const md = baselineMarkdown(readRuns());
  const file = join(args.out, "report.md");
  writeFileSync(file, md);
  console.log(md);
  console.log(`wrote ${file}`);
}

async function main(): Promise<void> {
  if (args.help) return void console.log(USAGE);
  if (args.report) return writeReport();
  if (args.rejudge) return rejudge(args.rejudge.split(",").map((s) => s.trim()));
  const config = args.config;
  if (!config || !/^[\w.-]+$/.test(config) || !args.model || !args.effort) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  checkSnapshotName(args.name);
  const only = args.only?.split(",").map((s) => s.trim());
  const scenarios = BASELINE_SCENARIOS.filter((s) => !only || only.includes(s.id));
  const dir = join(args.out, config);
  mkdirSync(dir, { recursive: true });
  const first = readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f)).length + 1;
  for (let run = first; run < first + Number(args.runs); run++) {
    if (!args["no-restore"]) {
      console.log(`run ${run}: restoring snapshot ${args.name}`);
      console.log(await stack.restore(args.name));
    }
    await stack.waitHealthy();
    const secret = stack.env("ROME_JWT_SECRET") ?? DEV_JWT_SECRET;
    const api = new Api(args["base-url"], args.user, secret);
    await api.checkGuardian();
    const loadBefore = loadavg();
    const startedAt = new Date().toISOString();
    const results = await pool(scenarios, Number(args.concurrency), (s) =>
      playScenario(api, s, run),
    );
    writeFileSync(
      join(dir, `run-${run}.json`),
      JSON.stringify(
        {
          version: BASELINE_VERSION,
          config,
          model: args.model,
          effort: args.effort,
          run,
          startedAt,
          concurrency: Number(args.concurrency),
          load: { before: loadBefore, after: loadavg() },
          scenarios: results,
        },
        null,
        2,
      ),
    );
  }
  writeReport();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
