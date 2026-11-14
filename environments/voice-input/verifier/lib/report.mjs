// The Markdown form of a run's report. report.json beside it holds the same facts in full.

const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");

function part(name, value) {
  if (!value || typeof value !== "object") return `- ${name}: ${value ?? "unknown"}`;
  if (!("commit" in value)) return `- ${name}: \`${JSON.stringify(value)}\``;
  return `- ${name}: \`${value.commit}\`${value.dirty ? " (uncommitted changes)" : ""}`;
}

function status(result) {
  if (result.status === "pass" && result.partial) return "pass (partly checked)";
  return result.status.replaceAll("_", " ");
}

/** The transcriber after the run set it, which the environment's version at the start predates. */
function inUse(used, atStart) {
  if (!used) return [part("Transcriber at the start", atStart)];
  const env = used.environment ?? {};
  const named = used.named ? `${used.named.provider} at ${used.named.host}` : "no place";
  return [
    `- Transcriber in use: the environment's is ${env.provider ?? "unknown"}${env.model ? `, model ${env.model}` : ""}${env.url || env.host ? ` at ${env.url ?? env.host}` : ""}; Rome names ${named}${used.via ? `, via ${used.via}` : ""}`,
  ];
}

export function renderMarkdown(report) {
  const { underTest, summary } = report;
  const lines = [
    `# Voice input verifier run, ${report.startedAt}`,
    "",
    `Rules version ${report.rulesVersion}, place ${report.place}. ${summary.pass} of ${summary.of} rules pass, ${summary.fail} fail, ${summary.notChecked} not checked.`,
    "",
    "## Under test",
    "",
    part("Product", underTest.product),
    part("Environment, as built", underTest.environment),
    ...(underTest.environmentCheckout
      ? [part("Environment checkout, running its scripts", underTest.environmentCheckout)]
      : []),
    part("Verifier", underTest.verifier),
    `- Transcriber mode asked for: ${report.transcriberMode}`,
    ...inUse(report.transcriberInUse, underTest.transcriber),
    `- Waits: listening ${report.waits.afterSpeechMs / 1000} s past the last word, ${report.waits.sendCheckMs / 1000} s for a message nobody sent, ${report.waits.sendMs / 1000} s for a sent message, field steady for ${report.waits.steadyMs / 1000} s`,
    `- Started ${report.startedAt}, finished ${report.finishedAt}`,
  ];
  if (report.dirty.length > 0)
    lines.push("", `Run with --dirty: uncommitted changes in ${report.dirty.join(", ")}.`);
  lines.push("", "## Results", "", "| Rule | Result | Reason |", "| --- | --- | --- |");
  for (const r of report.results)
    lines.push(`| ${r.rule} ${r.title} | ${status(r)} | ${cell(r.reason)} |`);
  for (const r of report.results) {
    if (r.checks.length === 0) continue;
    lines.push("", `## Rule ${r.rule}: ${r.title}`, "");
    for (const c of r.checks) {
      const label = c.status === "info" ? "" : `${c.status.replaceAll("_", " ")}. `;
      const evidence = c.evidence.length > 0 ? ` Evidence: ${c.evidence.join(", ")}.` : "";
      lines.push(`- **${c.name}**: ${label}${c.detail.replace(/\.$/, "")}.${evidence}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
