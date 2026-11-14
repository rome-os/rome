// The Markdown form of a run's report. report.json beside it holds the same facts in full.

function status(result) {
  if (result.status === "pass" && result.partial) return "pass (partly checked)";
  if (result.status === "fail" && result.stoppedByEnvoy) return "fail (the envoy stopped a reply)";
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
    `Answered ${report.answered.answered} of ${report.answered.sent} messages sent to the agent.`,
    "",
    ...(report.stopped
      ? [
          `Stopped: ${report.stopped}. No rule was scored. The opening mention in general (${report.liveness.questionId}) got no answer within the reply wait.`,
        ]
      : [`Rules version ${report.rulesVersion}.`, "", ...summaryLines(report)]),
    "",
    "## Under test",
    "",
    part("Rome", underTest.rome),
    part("Agent (rome_apps/chief-of-staff)", underTest.agent),
    ...(underTest.agent?.merged ?? []).map((m) => `  - built with ${m.ref} at \`${m.commit}\``),
    part("Environment", underTest.environment),
    part("Verifier", underTest.verifier),
    `- Model: ${typeof underTest.model === "object" && underTest.model !== null ? `\`${JSON.stringify(underTest.model)}\`` : (underTest.model ?? "unknown")}`,
    `- Judge: ${report.judge}, calibrated ${report.judgeCalibration}`,
    `- Run from: \`${report.runFrom.dir}\` at \`${report.runFrom.commit}\``,
    `- Rome's logs: ${report.logs === "logs" ? "`logs/` beside this report" : report.logs}`,
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
  if (report.answerTimes.length > 0) {
    lines.push(
      "",
      "## Answer times",
      "",
      "Only A1 holds the agent to a time (2 minutes). Every other question takes any answer within the reply wait.",
      "",
      "| Rule | Chat | Question | Answer | Seconds |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const t of report.answerTimes)
      lines.push(
        `| ${t.rule} | ${t.chat} | ${t.questionId} | ${t.replyId ?? "none"} | ${t.seconds ?? "no answer"} |`,
      );
  }
  if (report.stoppedByEnvoy.length > 0) {
    lines.push(
      "",
      "## Stopped by the envoy",
      "",
      "Replies the agent wrote that the envoy held or rejected. A question left unanswered this way still fails its rule, since the team got no answer, but the fault is the envoy's, not the agent's. A message that was not a question is listed and not scored.",
      "",
      "| Rule | Chat | Message | Envoy | Scored | Agent's reply | Envoy's reason |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    const cell = (s) =>
      String(s ?? "")
        .replaceAll("|", "\\|")
        .replaceAll("\n", " ");
    for (const s of report.stoppedByEnvoy)
      lines.push(
        `| ${s.rule ?? "?"} | ${s.chat ?? "?"} | ${s.questionId} | ${s.status} | ${s.scored ? "yes, fails its rule" : "no"} | ${cell(s.reply)} | ${cell(s.reason)} |`,
      );
  }
  if (report.romeEvents.length > 0) {
    lines.push(
      "",
      "## Rome restarted during the run",
      "",
      "Each question below waited across a Rome restart, so it was posted once more after Rome came back. A rule whose repost also crossed a restart is not checked: Rome was down.",
      "",
    );
    for (const e of report.romeEvents)
      lines.push(`- ${e.rule}: ${e.questionId}, posted again as ${e.repostedAs}: ${e.outcome}.`);
  }
  lines.push(...failureLines(report.failures));
  return `${lines.join("\n")}\n`;
}

function failureLines({ earlierRuns, counts, limit }) {
  const lines = [
    "",
    "## Failures across runs",
    "",
    `This run and ${earlierRuns.length} earlier runs. The loop stops when a rule fails more than ${limit} times. Not checked is not a failure.`,
    "",
  ];
  const rules = Object.keys(counts).sort();
  if (rules.length === 0) return [...lines, "No rule has failed."];
  lines.push("| Rule | Failures | |", "| --- | --- | --- |");
  for (const rule of rules) {
    const n = counts[rule];
    const note =
      n > limit
        ? `failed more than ${limit} times: the loop stops`
        : n === limit
          ? "one more failure stops the loop"
          : "";
    lines.push(`| ${rule} | ${n} | ${note} |`);
  }
  return lines;
}
