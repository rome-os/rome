// The Markdown form of a run's report. report.json beside it holds the same facts in full.

function status(result) {
  if (result.status === "pass" && result.partial) return "pass (partly checked)";
  return result.status.replace("_", " ");
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
    `Rules version ${report.rulesVersion}. ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.notChecked} not checked.`,
    "",
    "## Under test",
    "",
    part("Rome", underTest.rome),
    part("Agent (rome_apps/chief-of-staff)", underTest.agent),
    part("Environment", underTest.environment),
    part("Verifier", underTest.verifier),
    `- Model: ${underTest.model ?? "unknown"}`,
    `- Judge: ${report.judge}`,
    `- Waits: reply ${report.waits.replyMs / 1000} s, A1 ${report.waits.a1Ms / 1000} s, poll ${report.waits.pollMs / 1000} s`,
  ];
  if (report.dirty.length > 0) {
    lines.push("", `Run with --dirty: uncommitted changes in ${report.dirty.join(", ")}.`);
  }
  for (const note of report.notes ?? []) lines.push("", note);
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
        `- **${c.name}**: ${c.status.replace("_", " ")}. ${c.detail}. Evidence: ${c.evidence.join(", ") || "none"}.`,
      );
      if (c.quote) lines.push("", "  > " + c.quote.replaceAll("\n", "\n  > "), "");
    }
  }
  return `${lines.join("\n")}\n`;
}
