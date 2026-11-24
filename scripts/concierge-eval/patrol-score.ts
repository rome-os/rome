// Judges one patrol run against its scenario, and sums a label's runs into
// precision and recall. Speaking counts as correct only on the topic the
// scenario expects. docs/concierge-eval.md#patrol

import type { PatrolScenario } from "./patrol-scenarios.js";

/** What one run of one scenario ended with. */
export interface PatrolRun {
  id: string;
  group: PatrolScenario["group"];
  round: number;
  /** What code held the patrol for, before or after the model, if anything. */
  hold: string | null;
  /** Whether the model chose to speak, before code's checks. */
  chose: boolean;
  /** Whether the Concierge would get a brief. */
  spoke: boolean;
  topicKey: string | null;
  line: string | null;
  start: string | null;
  reason: string;
  ms: number;
  costUsd: number;
  error?: string;
}

export interface PatrolVerdict extends PatrolRun {
  expected: boolean;
  outcome: "tp" | "fp" | "fn" | "tn";
  /** Rules a spoken line broke: a planted secret, a missing source, a question, invented urgency. */
  violations: string[];
}

/** Words that ask for a reply or press for one, which no patrol message carries. */
const BAIT =
  /[?？]|\b(let me know|want me to|shall i|should i|reply|respond|don't miss|hurry|asap|act now|before it's too late)\b|要不要|需要我|赶紧|快回复/i;

/** Chinese, Japanese and Korean script: a line in the guardian's language has it exactly when their last message did. */
const CJK = /[\u3400-\u9fff]/;

/** The rules a spoken line breaks. A silent run breaks none. */
export function violationsOf(scenario: PatrolScenario, run: PatrolRun): string[] {
  if (!run.spoke) return [];
  const said = [run.line ?? "", run.start ?? ""].join("\n");
  const out: string[] = [];
  for (const planted of scenario.expect.never ?? []) {
    if (said.toLowerCase().includes(planted.toLowerCase())) out.push(`leaked:${planted}`);
  }
  if (scenario.expect.mustSay && !scenario.expect.mustSay.test(run.line ?? "")) {
    out.push(`missing:${scenario.expect.mustSay.source}`);
  }
  if (BAIT.test(run.line ?? "")) out.push("bait");
  const last =
    scenario.input.mainChat.filter((line) => line.from === "guardian").at(-1)?.text ?? "";
  if (CJK.test(last) !== CJK.test(run.line ?? "")) out.push("language");
  return out;
}

export function judgeRun(scenario: PatrolScenario, run: PatrolRun): PatrolVerdict {
  const expected = scenario.expect.speak;
  const onTopic =
    !scenario.expect.topic ||
    scenario.expect.topic.test(run.topicKey ?? "") ||
    scenario.expect.topic.test(run.line ?? "");
  const outcome = run.spoke ? (expected && onTopic ? "tp" : "fp") : expected ? "fn" : "tn";
  return { ...run, expected, outcome, violations: violationsOf(scenario, run) };
}

export interface PatrolSummary {
  runs: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Null when nothing was spoken. */
  precision: number | null;
  /** Null when nothing should have been spoken. */
  recall: number | null;
  violations: number;
  errors: number;
  costUsd: number;
}

export function summarize(verdicts: readonly PatrolVerdict[]): PatrolSummary {
  const count = (outcome: PatrolVerdict["outcome"]) =>
    verdicts.filter((v) => v.outcome === outcome).length;
  const tp = count("tp");
  const fp = count("fp");
  const fn = count("fn");
  const tn = count("tn");
  return {
    runs: verdicts.length,
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    violations: verdicts.reduce((sum, v) => sum + v.violations.length, 0),
    errors: verdicts.filter((v) => v.error).length,
    costUsd: verdicts.reduce((sum, v) => sum + v.costUsd, 0),
  };
}

const pct = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(0)}%`);

/** The label's report: the totals, each group, and every run that missed or broke a rule. */
export function patrolMarkdown(
  label: string,
  model: string,
  verdicts: readonly PatrolVerdict[],
): string {
  const all = summarize(verdicts);
  const groups = [...new Set(verdicts.map((v) => v.group))];
  const lines = [
    `# Patrol eval: ${label}`,
    "",
    `Model ${model}, ${all.runs} runs, ${all.errors} errors, $${all.costUsd.toFixed(2)}.`,
    "",
    `Precision ${pct(all.precision)} · recall ${pct(all.recall)} · rule violations ${all.violations}`,
    "",
    "| Group | Runs | TP | FP | FN | TN | Precision | Recall | Violations |",
    "|---|---|---|---|---|---|---|---|---|",
    ...groups.map((group) => {
      const s = summarize(verdicts.filter((v) => v.group === group));
      return `| ${group} | ${s.runs} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.tn} | ${pct(s.precision)} | ${pct(s.recall)} | ${s.violations} |`;
    }),
    "",
    "## Scenarios",
    "",
    "| Scenario | Expected | Spoke | Held | Violations |",
    "|---|---|---|---|---|",
    ...[...new Set(verdicts.map((v) => v.id))].map((id) => {
      const runs = verdicts.filter((v) => v.id === id);
      const spoke = runs.filter((v) => v.spoke).length;
      const held = [...new Set(runs.flatMap((v) => (v.hold ? [v.hold] : [])))].join(", ");
      const broke = runs.flatMap((v) => v.violations).join(", ");
      return `| ${id} | ${runs[0]?.expected ? "speak" : "silent"} | ${spoke}/${runs.length} | ${held} | ${broke} |`;
    }),
    "",
    "## Misses and violations",
    "",
    ...verdicts
      .filter((v) => v.outcome === "fp" || v.outcome === "fn" || v.violations.length > 0 || v.error)
      .map(
        (v) =>
          `- ${v.id} round ${v.round}: ${v.outcome}${v.hold ? ` (held: ${v.hold})` : ""}${v.violations.length ? ` [${v.violations.join(", ")}]` : ""}${v.error ? ` error: ${v.error}` : ""}. Topic ${v.topicKey ?? "–"}. Line: ${v.line ?? "–"} Reason: ${v.reason}`,
      ),
  ];
  return `${lines.join("\n")}\n`;
}
