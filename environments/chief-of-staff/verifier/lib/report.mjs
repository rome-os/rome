// The Markdown form of a run's report. report.json beside it holds the same facts in full.

function status(result) {
  if (result.status === "pass" && result.partial) return "pass (partly checked)";
  return result.status.replaceAll("_", " ");
}

function counts(t) {
  const parts = [`${t.pass} of ${t.of} pass`];
  if (t.fail) parts.push(`${t.fail} fail`);
  if (t.waitsOnDesign) parts.push(`${t.waitsOnDesign} waiting on a design decision`);
  if (t.notChecked) parts.push(`${t.notChecked} not checked`);
  return parts.join(", ");
}

function summaryLines(report) {
  const { rules, byLeg } = report.summary;
  const legRules = Object.keys(byLeg);
  const lines = [
    `- ${legRules.length > 0 ? `Rules other than ${legRules.join(", ")}` : "Rules"}: ${counts(rules)}.`,
  ];
  for (const [rule, legs] of Object.entries(byLeg))
    lines.push(`- ${rule} by leg: ${counts(legs)}.`);
  return lines;
}

function part(name, value) {
  if (!value || typeof value !== "object") return `- ${name}: ${value ?? "unknown"}`;
  return `- ${name}: \`${value.commit ?? "unknown"}\`${value.dirty ? " (uncommitted changes)" : ""}`;
}

export function renderMarkdown(report) {
  const { underTest } = report;
  const lines = [
    `# Chief of staff verifier run, ${report.startedAt}`,
    "",
    `Rules version ${report.rulesVersion}.`,
    "",
    ...summaryLines(report),
    "",
    "## Under test",
    "",
    part("Rome", underTest.rome),
    part("Agent (rome_apps/chief-of-staff)", underTest.agent),
    part("Environment", underTest.environment),
    part("Verifier", underTest.verifier),
    `- Model: ${typeof underTest.model === "object" && underTest.model !== null ? `\`${JSON.stringify(underTest.model)}\`` : (underTest.model ?? "unknown")}`,
    `- Judge: ${report.judge}`,
    `- Waits: reply ${report.waits.replyMs / 1000} s, A1 ${report.waits.a1Ms / 1000} s, poll ${report.waits.pollMs / 1000} s`,
  ];
  if (report.dirty.length > 0) {
    lines.push("", `Run with --dirty: uncommitted changes in ${report.dirty.join(", ")}.`);
  }
  for (const note of report.notes ?? []) lines.push("", note);
  const waiting = report.results.flatMap((r) =>
    r.checks.filter((c) => c.status === "waits_on_design").map((c) => ({ rule: r.rule, ...c })),
  );
  if (waiting.length > 0) {
    lines.push("", "## Waiting on a design decision", "", "Not counted as agent failures.", "");
    for (const c of waiting)
      lines.push(`- ${c.rule} ${c.name}: ${c.detail}. Evidence: ${c.evidence.join(", ")}.`);
  }
  lines.push(
    "",
    "## Results",
    "",
    "| Rule | Result | Reason | Evidence |",
    "| --- | --- | --- | --- |",
  );
  for (const r of report.results) {
    const reason = String(r.reason).replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(
      `| ${r.rule} ${r.title ?? ""} | ${status(r)} | ${reason} | ${r.evidence.join(", ")} |`,
    );
  }
  for (const r of report.results) {
    if (r.checks.length === 0) continue;
    lines.push("", `## ${r.rule} ${r.title}`, "");
    for (const c of r.checks) {
      lines.push(
        `- **${c.name}**: ${c.status.replaceAll("_", " ")}. ${c.detail}. Evidence: ${c.evidence.join(", ") || "none"}.`,
      );
      if (c.quote) lines.push("", "  > " + c.quote.replaceAll("\n", "\n  > "), "");
    }
  }
  return `${lines.join("\n")}\n`;
}
