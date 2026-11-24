// Pacing for Slack's history limit, and the repeated runs of rules 5 to 8.

/**
 * Waits until Slack's history limit lets the app read again: one window past
 * the app's last conversations.history and conversations.replies call in the
 * workspace since `ctx.paceSince`. Returns the milliseconds waited.
 */
export async function pace(ctx) {
  const started = Date.now();
  const windowMs = ctx.env.historyLimit.windowMs;
  for (;;) {
    let last = 0;
    for (const method of ["conversations.history", "conversations.replies"]) {
      const calls = await ctx.slack.calls({ team: ctx.team, method, since: ctx.paceSince });
      for (const c of calls) last = Math.max(last, Date.parse(c.at) || 0);
    }
    const due = last + windowMs + ctx.paceMarginMs;
    if (Date.now() >= due) return Date.now() - started;
    await ctx.sleep(Math.min(due - Date.now(), 5000));
  }
}

/**
 * Runs `once(ctx, run)` `ctx.runs` times; the rule passes only when every run
 * passes. A run that fails or is not checked ends the rule there, as the
 * later runs cannot change its result.
 */
export async function repeated(ctx, once) {
  const runs = [];
  for (let run = 1; run <= ctx.runs; run++) {
    const t0 = Date.now();
    ctx.log(`  run ${run} of ${ctx.runs}`);
    const r = await once(ctx, run);
    runs.push({ run, ...r, seconds: Math.round((Date.now() - t0) / 1000) });
    ctx.log(`    ${r.result}: ${r.reason}`);
    if (r.result !== "pass") {
      const left = ctx.runs - run;
      const reason = `run ${run} of ${ctx.runs}: ${r.reason}${left ? `; the ${left} later run(s) were not made` : ""}`;
      return { result: r.result, reason, evidence: { runs } };
    }
  }
  return {
    result: "pass",
    reason: `all ${ctx.runs} run(s) passed: ${runs.map((r) => r.reason).join(" | ")}`,
    evidence: { runs },
  };
}

/** The reason a rule cannot be checked in this environment, or null. */
export function lacks(what, have, need) {
  return have >= need ? null : `the environment offers ${have} ${what}; the rule needs ${need}`;
}
