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
  /** The owner's language; absent on runs saved before the Chinese scenarios. */
  lang?: "en" | "zh";
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
  /** The turns of setup messages, which only prepare the chat: left out of the timings. */
  setupTurnIds?: string[];
  /** Failed hard checks; empty when all passed. */
  notes: string[];
  /** The host's 1-minute load average when the play started and ended. */
  load?: { before: number; after: number };
  /** The scenario's own figures, such as answer lengths. */
  measures?: Record<string, number | null>;
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
/** The owner's turns of the runs, setup messages left out. */
const guardianTurns = (runs: ScenarioRun[]) =>
  runs.flatMap((r) =>
    r.turns.filter((t) => t.trigger === "guardian" && !r.setupTurnIds?.includes(t.turnId)),
  );

export function configRow(runs: ScenarioRun[]): string {
  const guardian = guardianTurns(runs);
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

/** The kinds of standing-rule notes, by their prefix (baseline-rules.ts). */
const RULE_KINDS = [
  ["rule:", "Rule regressions"],
  ["zh:", "Chinese style"],
  ["drift:", "Length drift"],
  ["effort:", "Effort mismatch"],
] as const;

const isRuleNote = (note: string) => RULE_KINDS.some(([prefix]) => note.startsWith(prefix));

/** Rows answered in the owner's own turn, whose first say is the latency the owner feels. */
const INLINE_ROWS = new Set([
  "chat",
  "simple-qa",
  "quick-lookup",
  "reasoning",
  "recall",
  "multi-turn",
]);

/** One row per configuration over every scenario it played. */
function overview(runs: ScenarioRun[]): string[] {
  const head = [
    "Config",
    "Plays",
    "Checks passed",
    "Rule regressions",
    "Chinese style",
    "Length drift",
    "Judge EN",
    "Judge ZH",
    "Inline first say p50/p95 s",
    "Long-context first say p50/p95 s",
    "Send→task result p50/p95 s",
  ];
  const configs = [...new Set(runs.map((r) => r.config))].sort();
  const judged = (rs: ScenarioRun[]) => {
    const scores = rs.flatMap((r) => (r.verdict ? [r.verdict.score] : []));
    return scores.length ? `${fixed(mean(scores), 2)} (${scores.length})` : "–";
  };
  const notesOf = (rs: ScenarioRun[], prefix: string) =>
    rs.reduce((n, r) => n + r.notes.filter((note) => note.startsWith(prefix)).length, 0);
  const rows = configs.map((config) => {
    const rs = runs.filter((r) => r.config === config);
    const passed = rs.filter((r) => r.notes.every(isRuleNote)).length;
    const inline = guardianTurns(rs.filter((r) => INLINE_ROWS.has(r.row)));
    const long = guardianTurns(rs.filter((r) => r.row === "long-context"));
    const tasks = rs.filter((r) => r.resultMs !== null);
    return `| ${[
      config,
      String(rs.length),
      `${passed}/${rs.length}`,
      String(notesOf(rs, "rule:")),
      String(notesOf(rs, "zh:")),
      String(notesOf(rs, "drift:")),
      judged(rs.filter((r) => (r.lang ?? "en") === "en")),
      judged(rs.filter((r) => r.lang === "zh")),
      p(inline.map((t) => t.firstSayMs)),
      long.length ? p(long.map((t) => t.firstSayMs)) : "–",
      tasks.length ? p(tasks.map((r) => r.resultMs)) : "–",
    ].join(" | ")} |`;
  });
  return [
    "## Overview",
    "",
    "Checks passed counts plays whose scenario checks all passed; the standing rules are counted in their own columns. Judge columns give the mean score and the number of scores.",
    "",
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows,
    "",
  ];
}

/** Every standing-rule note, by kind, with the play it came from. */
function ruleNotes(runs: ScenarioRun[]): string[] {
  const out: string[] = [];
  for (const [prefix, title] of RULE_KINDS) {
    const hits = runs.flatMap((r) =>
      r.notes
        .filter((note) => note.startsWith(prefix))
        .map((note) => `- ${r.config} r${r.run} ${r.id}: ${note.slice(prefix.length).trim()}`),
    );
    if (hits.length) out.push(`## ${title}`, "", ...hits.sort(), "");
  }
  return out;
}

/** The scenario's own figures for each play. */
function measuresTable(runs: ScenarioRun[]): string[] {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.measures ?? {})))];
  return [
    "Figures:",
    "",
    `| Config | Run | ${keys.join(" | ")} |`,
    `|---|---|${keys.map(() => "---").join("|")}|`,
    ...runs.map(
      (r) =>
        `| ${r.config} | ${r.run} | ${keys.map((key) => String(r.measures?.[key] ?? "–")).join(" | ")} |`,
    ),
  ];
}

export function baselineMarkdown(runs: ScenarioRun[]): string {
  const out = [
    "# Concierge baseline",
    "",
    "Guardian turns only, unless the column names a relay, and without the setup messages that preload a chat. Times from the owner's send. Runs are scenario plays; p95 over few runs is the max.",
    "",
    ...overview(runs),
    ...ruleNotes(runs),
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
    const measured = ofScenario.filter((r) => r.measures);
    if (measured.length) out.push("", ...measuresTable(measured));
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
