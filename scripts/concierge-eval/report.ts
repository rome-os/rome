// A round's result, the aggregate of a label's rounds, and the side-by-side
// comparison of two labels, as JSON and Markdown. docs/concierge-eval.md

import type { ChatMetrics } from "./metrics.js";
import { round2 } from "./metrics.js";

export interface Checks {
  /** The Concierge showed a card for each decision the scenario needs. */
  decisionAsked?: boolean;
  /** Each expected result reached the owner in a Concierge message. */
  resultReached?: boolean;
  /** Recurring work became a Concierge schedule, with no routine of a task chat's own. */
  scheduled?: boolean;
  /** No owner message went unheard, and every task ended as the scenario expects. */
  nothingDropped: boolean;
  /** Why a check failed. */
  notes: string[];
}

export interface ScenarioResult {
  id: string;
  chatId: string;
  metrics: ChatMetrics;
  checks: Checks;
  tasks: { title: string; status: string; endReason: string | null }[];
  seconds: number;
}

export interface RoundResult {
  label: string;
  round: number;
  startedAt: string;
  scenariosVersion: number;
  /** The provider and model of the scenario chats' sessions. */
  models: string[];
  /** A hash of the prompt sources the stack runs, to tell two labels' prompts apart. */
  promptHash: string;
  waitExpiryMinutes: number | null;
  scenarios: ScenarioResult[];
}

interface Metric {
  name: string;
  value: (s: ScenarioResult) => number;
  /** How a label's scenarios add up: summed, or averaged. */
  total: "sum" | "mean";
}

const passed = (c: Checks) =>
  [c.decisionAsked, c.resultReached, c.scheduled, c.nothingDropped].filter((v) => v !== undefined);

export const METRICS: Metric[] = [
  { name: "Owner msgs", value: (s) => s.metrics.ownerMessages, total: "sum" },
  { name: "Concierge msgs", value: (s) => s.metrics.conciergeMessages, total: "sum" },
  { name: "Per owner msg", value: (s) => s.metrics.perOwnerMessage, total: "mean" },
  { name: "Task cards", value: (s) => s.metrics.byKind.task_card, total: "sum" },
  {
    name: "Ask cards",
    value: (s) => s.metrics.byKind.ask_card + s.metrics.byKind.own_ask,
    total: "sum",
  },
  { name: "Forwards", value: (s) => s.metrics.byKind.forward, total: "sum" },
  { name: "Says", value: (s) => s.metrics.byKind.say, total: "sum" },
  { name: "Echo", value: (s) => s.metrics.echoes, total: "sum" },
  { name: "Ack", value: (s) => s.metrics.acks, total: "sum" },
  { name: "Bursts", value: (s) => s.metrics.bursts, total: "sum" },
  { name: "Turns", value: (s) => s.metrics.turns, total: "sum" },
  { name: "Silent turns", value: (s) => s.metrics.silentTurns, total: "sum" },
  { name: "Prompt tok/turn", value: (s) => s.metrics.inputTokens.mean, total: "mean" },
  { name: "Cached tok/turn", value: (s) => s.metrics.cacheReadTokens.mean, total: "mean" },
  { name: "Out tok/turn", value: (s) => s.metrics.outputTokens.mean, total: "mean" },
  {
    name: "Checks passed",
    value: (s) => passed(s.checks).filter(Boolean).length,
    total: "sum",
  },
  { name: "Checks", value: (s) => passed(s.checks).length, total: "sum" },
];

function totalOf(metric: Metric, scenarios: ScenarioResult[]): number {
  const values = scenarios.map(metric.value);
  const sum = values.reduce((a, b) => a + b, 0);
  return metric.total === "sum" ? sum : values.length ? round2(sum / values.length) : 0;
}

function table(head: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

const checkCell = (c: Checks) =>
  passed(c)
    .map((v) => (v ? "✓" : "✗"))
    .join("");

export function roundMarkdown(r: RoundResult): string {
  const head = ["Scenario", ...METRICS.filter((m) => m.name !== "Checks").map((m) => m.name)];
  const rows = r.scenarios.map((s) => [
    s.id,
    ...METRICS.filter((m) => m.name !== "Checks").map((m) =>
      m.name === "Checks passed" ? checkCell(s.checks) : m.value(s),
    ),
  ]);
  rows.push([
    "**All**",
    ...METRICS.filter((m) => m.name !== "Checks").map((m) =>
      m.name === "Checks passed"
        ? `${totalOf(m, r.scenarios)}/${totalOf(METRICS.at(-1) as Metric, r.scenarios)}`
        : totalOf(m, r.scenarios),
    ),
  ]);
  const notes = r.scenarios.flatMap((s) => s.checks.notes.map((n) => `- ${s.id}: ${n}`));
  const flagged = r.scenarios.flatMap((s) =>
    s.metrics.messages
      .filter((m) => m.echo || m.ack)
      .map(
        (m) => `- ${s.id} (${m.echo ? "echo" : "ack"}): ${JSON.stringify(m.text.slice(0, 160))}`,
      ),
  );
  return [
    `## ${r.label}, round ${r.round}`,
    "",
    `Started ${r.startedAt}. Models: ${r.models.join(", ") || "unknown"}. Prompt ${r.promptHash.slice(0, 12)}. Wait expiry ${r.waitExpiryMinutes ?? "default"} min. Scenarios v${r.scenariosVersion}.`,
    "",
    table(head, rows),
    ...(notes.length ? ["", "Failed checks:", ...notes] : []),
    ...(flagged.length ? ["", "Flagged messages:", ...flagged] : []),
    "",
  ].join("\n");
}

export interface Spread {
  mean: number;
  min: number;
  max: number;
}

function spread(values: number[]): Spread {
  if (!values.length) return { mean: 0, min: 0, max: 0 };
  return {
    mean: round2(values.reduce((a, b) => a + b, 0) / values.length),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

const fmt = (s: Spread) => (s.min === s.max ? `${s.mean}` : `${s.mean} (${s.min}–${s.max})`);

/** Each metric's spread over rounds, for every scenario and for the whole round. */
export function aggregate(rounds: RoundResult[]): Map<string, Map<string, Spread>> {
  const byRow = new Map<string, Map<string, Spread>>();
  const ids = [...new Set(rounds.flatMap((r) => r.scenarios.map((s) => s.id)))];
  for (const id of ids) {
    const runs = rounds.flatMap((r) => r.scenarios.filter((s) => s.id === id));
    byRow.set(id, new Map(METRICS.map((m) => [m.name, spread(runs.map(m.value))])));
  }
  byRow.set(
    "All",
    new Map(METRICS.map((m) => [m.name, spread(rounds.map((r) => totalOf(m, r.scenarios)))])),
  );
  return byRow;
}

export function aggregateMarkdown(label: string, rounds: RoundResult[]): string {
  const agg = aggregate(rounds);
  const names = METRICS.map((m) => m.name);
  const rows = [...agg].map(([id, metrics]) => [
    id === "All" ? "**All**" : id,
    ...names.map((n) => fmt(metrics.get(n) as Spread)),
  ]);
  return [
    `## ${label}: ${rounds.length} round${rounds.length === 1 ? "" : "s"}, mean (min–max)`,
    "",
    `Models: ${[...new Set(rounds.flatMap((r) => r.models))].join(", ")}. Prompt ${[...new Set(rounds.map((r) => r.promptHash.slice(0, 12)))].join(", ")}.`,
    "",
    table(["Scenario", ...names], rows),
    "",
  ].join("\n");
}

/** The two labels side by side: every metric of the whole round, then a few per scenario. */
export function compareMarkdown(
  a: { label: string; rounds: RoundResult[] },
  b: { label: string; rounds: RoundResult[] },
): string {
  // Only the scenarios both labels played count, so a new scenario never
  // shifts the totals.
  const idsOf = (rs: RoundResult[]) => new Set(rs.flatMap((r) => r.scenarios.map((s) => s.id)));
  const idsA = idsOf(a.rounds);
  const idsB = idsOf(b.rounds);
  const common = (rs: RoundResult[]) =>
    rs.map((r) => ({
      ...r,
      scenarios: r.scenarios.filter((s) => idsA.has(s.id) && idsB.has(s.id)),
    }));
  const left = [...new Set([...idsA, ...idsB])].filter((id) => !(idsA.has(id) && idsB.has(id)));
  const aggA = aggregate(common(a.rounds));
  const aggB = aggregate(common(b.rounds));
  const delta = (x: Spread, y: Spread) => {
    const d = round2(y.mean - x.mean);
    return d > 0 ? `+${d}` : `${d}`;
  };
  const all = METRICS.map((m) => {
    const x = aggA.get("All")?.get(m.name) as Spread;
    const y = aggB.get("All")?.get(m.name) as Spread;
    return [m.name, fmt(x), fmt(y), delta(x, y)];
  });
  const warnings: string[] = [];
  const versions = new Set([...a.rounds, ...b.rounds].map((r) => r.scenariosVersion));
  if (versions.size > 1) warnings.push("The labels ran different scenario versions.");
  if (left.length) warnings.push(`Left out, since only one label played them: ${left.join(", ")}.`);
  const models = (rs: RoundResult[]) => [...new Set(rs.flatMap((r) => r.models))].sort().join(", ");
  if (models(a.rounds) !== models(b.rounds))
    warnings.push(`Models differ: ${models(a.rounds)} vs ${models(b.rounds)}.`);
  const perScenario = ["Concierge msgs", "Echo", "Task cards", "Checks passed"];
  const ids = [...aggA.keys()].filter((id) => id !== "All" && aggB.has(id));
  const scenarioRows = ids.map((id) => [
    id,
    ...perScenario.flatMap((n) => {
      const x = aggA.get(id)?.get(n) as Spread;
      const y = aggB.get(id)?.get(n) as Spread;
      return [`${fmt(x)} → ${fmt(y)}`];
    }),
  ]);
  return [
    `## ${a.label} (${a.rounds.length} rounds) vs ${b.label} (${b.rounds.length} rounds)`,
    "",
    ...warnings.map((w) => `> ${w}`),
    ...(warnings.length ? [""] : []),
    "Whole round, mean (min–max):",
    "",
    table(["Metric", a.label, b.label, "Δ"], all),
    "",
    "Per scenario, mean:",
    "",
    table(["Scenario", ...perScenario], scenarioRows),
    "",
  ].join("\n");
}
