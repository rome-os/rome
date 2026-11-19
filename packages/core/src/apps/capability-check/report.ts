// Renders capability verdicts as a Markdown gap report, grouped by goal and
// rule, so a reader sees first which rules hold and then where each breaks.

import { type AppVerdict, type Goal, RULES } from "./rules.js";

const GOALS: Record<Goal, string> = {
  discover: "Agents can discover what apps can do",
  interfaces: "App capabilities have interfaces for both agents and people",
};

export function renderReport(verdicts: readonly AppVerdict[]): string {
  const gaps = verdicts.flatMap((verdict) => verdict.gaps);
  const unverified = verdicts.flatMap((verdict) => verdict.unverified);
  const lines = [
    "# App capability check",
    "",
    `${verdicts.length} apps, ${gaps.length} gaps, ${unverified.length} left for a person to judge.`,
    "",
    "| App | " + RULES.map((rule) => rule.id).join(" | ") + " |",
    "| --- | " + RULES.map(() => "---").join(" | ") + " |",
    ...verdicts.map(
      (verdict) =>
        `| ${verdict.appId} | ` +
        RULES.map((rule) => {
          const count = verdict.gaps.filter((gap) => gap.rule === rule.id).length;
          if (count > 0) return String(count);
          return verdict.unverified.some((item) => item.rule === rule.id) ? "?" : "✓";
        }).join(" | ") +
        " |",
    ),
  ];

  for (const goal of Object.keys(GOALS) as Goal[]) {
    lines.push("", `## ${GOALS[goal]}`);
    for (const rule of RULES.filter((r) => r.goal === goal)) {
      const ruleGaps = gaps.filter((gap) => gap.rule === rule.id);
      const ruleUnverified = unverified.filter((item) => item.rule === rule.id);
      // A rule holds only where nothing was left unjudged.
      const verdict = [
        ruleGaps.length > 0 ? `${ruleGaps.length} gaps` : "",
        ruleUnverified.length > 0 ? `${ruleUnverified.length} left for a person to judge` : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push("", `### ${rule.id}: ${verdict || "holds"}`);
      lines.push("", rule.statement);
      if (ruleGaps.length > 0) lines.push("");
      for (const gap of ruleGaps) lines.push(`- **${gap.appId}** \`${gap.at}\`: ${gap.message}`);
    }
  }

  if (unverified.length > 0) {
    lines.push("", "## Left for a person to judge", "");
    for (const item of unverified)
      lines.push(`- **${item.appId}** ${item.rule} \`${item.at}\`: ${item.message}`);
  }
  return `${lines.join("\n")}\n`;
}
