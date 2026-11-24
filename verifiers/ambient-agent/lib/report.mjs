// The Markdown form of a run's report.json.

const cell = (s) =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
const short = (s, n = 160) =>
  String(s ?? "").length > n ? `${String(s).slice(0, n)}…` : String(s ?? "");
const secs = (ms) => `${Math.round((ms ?? 0) / 1000)} s`;
const where = (p) => (p ? `${p.channel}${p.threadTs ? `/${p.threadTs}` : ""}` : "");

function rounds(list) {
  const rows = list.map(
    (r) =>
      `| ${r.round}${r.askedByGuardian ? " (guardian)" : ""} | ${r.held ? "held" : r.answered ? "no value" : "no reply"} | ${r.fact?.ts ?? ""} | ${r.mention?.ts ?? ""} | ${secs(r.waitedForLimitMs)} | ${cell(short(r.replies?.map((p) => p.text).join(" / ")))} |`,
  );
  return [
    "| Round | Result | Fact ts | Mention ts | Waited for the limit | Reply |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function questions(list) {
  const rows = list.map(
    (q) =>
      `| ${q.dm ? "DM " : ""}${where(q)} | ${q.ts} | ${q.by} | ${q.verdict} | ${q.right.map(where).join(", ")} | ${q.wrong.map(where).join(", ")} |`,
  );
  return [
    "| Asked in | Mention ts | By | Verdict | Value in place | Value elsewhere |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function runEvidence(n, run) {
  const e = run.evidence ?? {};
  const out = ["", `### Run ${run.run}: ${run.result} (${run.seconds} s)`, "", run.reason];
  if (n === "5") {
    out.push(
      "",
      "| Burst | In place | Misplaced | Unanswered | Took | Waited for the limit |",
      "|---|---|---|---|---|---|",
    );
    for (const [i, b] of (e.bursts ?? []).entries())
      out.push(
        `| ${i + 1} (${b.size}) | ${b.answered} | ${b.misplaced} | ${b.unanswered} | ${b.seconds} s | ${secs(b.waitedForLimitMs)} |`,
      );
    out.push("", questions(e.questions ?? []));
  }
  if (n === "6")
    for (const p of e.pairs ?? []) {
      out.push(
        "",
        `Pair ${p.pair}: ${p.ok ? "each got their own chat's answer" : "failed"} (${p.seconds} s, waited ${secs(p.waitedForLimitMs)} for the limit)`,
        "",
        questions(p.asks),
      );
      for (const q of p.asks)
        for (const r of q.replies) out.push(`- reply in ${where(r)} at ${r.ts}: ${short(r.text)}`);
    }
  if (n === "7") out.push("", questions(e.questions ?? []));
  if (n === "8") {
    out.push(
      "",
      "| Round | Asked in | Result | Hand-off records | Others sent before the result | Others (not scored) | Took |",
      "|---|---|---|---|---|---|---|",
    );
    for (const r of e.rounds ?? [])
      out.push(
        `| ${r.round}${r.thread ? " (thread)" : ""} | ${where(r.ask)} | ${r.ask.verdict}${r.ask.wrong.length ? ` (elsewhere: ${r.ask.wrong.map(where).join(", ")})` : ""} | ${r.handOffs?.length ?? 0} | ${r.othersBeforeResult ?? "no result"} | ${r.others.answered} in place, ${r.others.misplaced} misplaced, ${r.others.unanswered} unanswered | ${r.seconds} s |`,
      );
    for (const r of e.rounds ?? [])
      for (const p of r.repliesInPlace)
        out.push(`- round ${r.round}, ${where(p)} ${p.ts}: ${short(p.text)}`);
  }
  return out;
}

/** Renders `report` (verify.mjs's report.json) as Markdown. */
export function markdown(report) {
  const cost = report.cost;
  const out = [
    `# Ambient agent: rule set ${report.rulesVersion}`,
    "",
    `Result: **${report.result}**${report.fault ? ` (${report.fault})` : ""}`,
    "",
    `- Product: ${report.commits.product}${report.commits.productRef ? ` (${report.commits.productRef})` : ""}`,
    `- Verifier: ${report.commits.verifier}`,
    `- Environment: ${report.commits.environment}`,
    `- Model: ${report.model}${report.effort ? ` at ${report.effort} effort` : ""}`,
    `- Instance: ${report.instance}, workspace ${report.workspace}; Slack's history limit ${report.historyLimit.on ? "on" : "off"} (one read per ${Math.round(report.historyLimit.windowMs / 1000)} s, ${report.historyLimit.maxMessages} messages)`,
    `- Rules 5 to 8: ${report.runsPerRule} run(s) each`,
    `- Started ${report.startedAt}, took ${report.seconds} s${report.logs ? `; instance logs in ${report.logs}` : ""}`,
    `- Model cost: ${cost == null ? "not reported by the environment" : cost.error ? cost.error : `$${cost.cost_usd} over ${cost.turns} turn(s)`}`,
    "",
    "| Rule | Result | Took | Reason |",
    "|---|---|---|---|",
    ...Object.entries(report.rules)
      .sort(([a], [b]) => a - b)
      .map(
        ([n, r]) => `| ${n}. ${r.title} | ${r.result} | ${r.seconds ?? 0} s | ${cell(r.reason)} |`,
      ),
  ];
  if (report.liveness)
    out.push(
      "",
      `Liveness: the guardian's mention ${report.liveness.mentionTs}, ${report.liveness.replies.length} reply(ies) in ${report.liveness.seconds} s.`,
    );
  if (report.bursts) {
    out.push("", "## Bursts (not scored)", "");
    if (report.bursts.sizes) {
      out.push(
        "| Mentions at once | In place | Misplaced | Unanswered | Took |",
        "|---|---|---|---|---|",
      );
      for (const s of report.bursts.sizes)
        out.push(
          `| ${s.size} | ${s.answered} | ${s.misplaced} | ${s.unanswered} | ${s.seconds} s |`,
        );
    } else out.push(report.bursts.reason);
  }
  for (const [n, r] of Object.entries(report.rules).sort(([a], [b]) => a - b)) {
    const e = r.evidence;
    if (!e) continue;
    out.push(
      "",
      `## Rule ${n}: ${r.title}`,
      "",
      `${r.result}: ${r.reason}${r.seconds !== undefined ? ` (${r.seconds} s)` : ""}`,
    );
    if (e.rounds && ["1", "3"].includes(n)) out.push("", rounds(e.rounds));
    if (e.threadRoundsNotCounted?.length)
      out.push("", "Mentions in a thread, not counted:", "", rounds(e.threadRoundsNotCounted));
    if (e.guardianRoundNotCounted)
      out.push("", "The guardian asks, not counted:", "", rounds([e.guardianRoundNotCounted]));
    if (e.runs) for (const run of e.runs) out.push(...runEvidence(n, run));
    if (e.messages !== undefined) {
      out.push(
        "",
        `${e.messages} messages (${Object.entries(e.byKind)
          .map(([k, v]) => `${v} ${k}`)
          .join(
            ", ",
          )}), then ${e.settleSeconds} s of waiting. Posts in the chat: ${e.postsInChat.length}; elsewhere: ${e.postsElsewhere.length}.`,
        "",
        `Web API calls in that time (not scored): ${
          e.webApiCalls.length
            ? Object.entries(
                e.webApiCalls.reduce((m, c) => ({ ...m, [c.method]: (m[c.method] ?? 0) + 1 }), {}),
              )
                .map(([k, v]) => `${k} ×${v}`)
                .join(", ")
            : "none"
        }.`,
      );
      for (const p of e.postsInChat) out.push(`- post ${p.ts}: ${short(p.text)}`);
    }
    if (e.a) {
      out.push("", `(a) ${e.a.result ?? (e.a.pass ? "pass" : "fail")}: ${e.a.reason}`);
      for (const f of e.a.evidence?.files ?? []) out.push(`- ${f}`);
      out.push("", `(b) ${e.b.result ?? (e.b.pass ? "pass" : "fail")}: ${e.b.reason}`);
      if (e.b.evidence)
        out.push(
          "",
          `Runner: \`${e.b.evidence.runner}\`, exit ${e.b.evidence.exit}, ${e.b.evidence.seconds} s; test file removed: ${e.b.evidence.removed}.`,
          "",
          "```",
          e.b.evidence.outputTail,
          "```",
        );
    }
  }
  return `${out.join("\n")}\n`;
}
