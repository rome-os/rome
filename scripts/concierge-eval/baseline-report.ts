// The baseline's report: one table per scenario, a row per configuration,
// with p50/p95 timings over the runs, what the turns cost, the hard checks
// and the judge's scores. docs/concierge-eval.md#baseline

import type { Verdict } from "./judge.js";
import type { TaskPath } from "./task-path.js";
import { type TimedTurn, secs, spread } from "./timing.js";

/** One scenario played once under one configuration. */
export interface ScenarioRun {
  id: string;
  row: string;
  config: string;
  model: string;
  effort: string;
  run: number;
  /** The scenario version the run was played at (BASELINE_VERSION). */
  version?: number;
  chatId: string;
  seconds: number;
  /** From the send to the last relayed result landing, for a task. */
  resultMs: number | null;
  turns: TimedTurn[];
  /** Failed hard checks; empty when all passed. */
  notes: string[];
  verdict: Verdict | null;
  transcript: string[];
  /** Where a delegated task's time went; absent for the other scenarios. */
  taskPath?: TaskPath | null;
}

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

const p = (values: (number | null)[]) => {
  const s = spread(values);
  return `${secs(s.p50)} / ${secs(s.p95)}`;
};

const fixed = (n: number | null, digits = 1) => (n === null ? "–" : n.toFixed(digits));

const k = (n: number | null) => (n === null ? "–" : `${Math.round(n / 1000)}k`);

/** The summary row of one scenario under one configuration. */
export function configRow(runs: ScenarioRun[]): string {
  const guardian = runs.flatMap((r) => r.turns.filter((t) => t.trigger === "guardian"));
  const system = runs.flatMap((r) => r.turns.filter((t) => t.trigger === "system"));
  const cold = guardian.filter((t) => t.session === "cold");
  const warm = guardian.filter((t) => t.session === "warm");
  const scores = runs.flatMap((r) => (r.verdict ? [r.verdict.score] : []));
  const passed = runs.filter((r) => r.notes.length === 0).length;
  const cells = [
    runs[0]?.config ?? "",
    String(runs.length),
    p(guardian.map((t) => t.ackMs)),
    p(guardian.map((t) => t.firstSayMs)),
    p(guardian.map((t) => t.durationMs)),
    `${p(cold.map((t) => t.firstSayMs))} (${cold.length})`,
    `${p(warm.map((t) => t.firstSayMs))} (${warm.length})`,
    p(guardian.map((t) => t.startMs)),
    system.length ? p(system.map((t) => t.firstSayMs)) : "–",
    runs.some((r) => r.resultMs !== null) ? p(runs.map((r) => r.resultMs)) : "–",
    fixed(mean(guardian.flatMap((t) => (t.modelCalls === null ? [] : [t.modelCalls])))),
    fixed(mean(guardian.map((t) => t.toolCalls))),
    k(spread(guardian.map((t) => t.contextTokens)).p50),
    k(mean(guardian.map((t) => t.cacheReadTokens))),
    k(mean(guardian.map((t) => t.cacheWriteTokens))),
    `${passed}/${runs.length}`,
    scores.length
      ? `${fixed(mean(scores), 2)} (${Math.min(...scores)}–${Math.max(...scores)})`
      : "–",
  ];
  return `| ${cells.join(" | ")} |`;
}

const HEADER = [
  "Config",
  "Runs",
  "👀/first sign p50/p95 s",
  "First say p50/p95 s",
  "Turn p50/p95 s",
  "First say cold (n)",
  "First say warm (n)",
  "Send→model start p50/p95 s",
  "Relay first say p50/p95 s",
  "Send→result p50/p95 s",
  "Model calls",
  "Tool calls",
  "Context p50",
  "Cache read",
  "Cache write",
  "Checks",
  "Judge mean (range)",
];

export function baselineMarkdown(runs: ScenarioRun[]): string {
  const out = [
    "# Concierge baseline",
    "",
    "Guardian turns only, unless the column names a relay. Times from the owner's send. Runs are scenario plays; p95 over few runs is the max.",
    "",
  ];
  const scenarios = [...new Set(runs.map((r) => r.id))];
  for (const id of scenarios) {
    const ofScenario = runs.filter((r) => r.id === id);
    out.push(`## ${id} (${ofScenario[0]?.row})`, "");
    out.push(`| ${HEADER.join(" | ")} |`, `|${HEADER.map(() => "---").join("|")}|`);
    // Runs of one scenario at different versions are never pooled: each
    // version gets its own rows, labelled, and the table says so.
    const versions = [...new Set(ofScenario.map((r) => r.version ?? 1))].sort((a, b) => a - b);
    const groups = [...new Set(ofScenario.map((r) => `${r.config}\u0000${r.version ?? 1}`))].sort();
    for (const group of groups) {
      const [config, version] = group.split("\u0000");
      const rows = ofScenario.filter(
        (r) => r.config === config && String(r.version ?? 1) === version,
      );
      const row = configRow(rows);
      out.push(
        versions.length > 1 ? row.replace(`| ${config} |`, `| ${config} (v${version}) |`) : row,
      );
    }
    if (versions.length > 1) {
      out.push(
        "",
        `⚠️ This scenario changed between runs (versions ${versions.join(", ")}): compare rows of one version only.`,
      );
    }
    const paths = ofScenario.filter((r) => r.taskPath);
    if (paths.length) out.push("", ...taskPathTable(paths));
    const failed = ofScenario.filter((r) => r.notes.length);
    if (failed.length) {
      out.push("", "Failed checks:");
      for (const r of failed) out.push(`- ${r.config} r${r.run}: ${r.notes.join("; ")}`);
    }
    const low = ofScenario.filter((r) => r.verdict && r.verdict.score <= 3);
    if (low.length) {
      out.push("", "Low scores:");
      for (const r of low)
        out.push(`- ${r.config} r${r.run} (${r.verdict?.score}): ${r.verdict?.why}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** The task path of each run: where a delegated task's time went, in seconds. */
function taskPathTable(runs: ScenarioRun[]): string[] {
  const head = [
    "Config",
    "Run",
    "Send→chat_start",
    "→task turn starts",
    "Task open",
    "Task model",
    "Task turns (n)",
    "Subagent calls",
    "Read/Grep/Glob",
    "Task end→relay turn",
    "Relay first say",
    "Send→result",
  ];
  const rows = runs.map((r) => {
    const t = r.taskPath as TaskPath;
    const calls = t.subagentCalls
      .map((c) => `${c.agent ?? c.tool} ${c.model ?? "?"} ${secs(c.ms)}s${c.parallel ? " ∥" : ""}`)
      .join("; ");
    return `| ${[
      r.config,
      String(r.run),
      secs(t.toChatStartMs),
      secs(t.taskStartGapMs),
      secs(t.taskOpenMs),
      t.taskModel ?? "?",
      `${secs(t.taskTurnsMs)} (${t.taskTurns})`,
      calls || "none",
      String(t.readCalls),
      secs(t.relayWaitMs),
      secs(t.relayFirstSayMs),
      secs(r.resultMs),
    ].join(" | ")} |`;
  });
  return [
    "Task path (s):",
    "",
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows,
  ];
}
