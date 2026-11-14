// What a scenario returns: checks folded into one rule result. A check has status pass,
// fail, not_checked, or info; an info check is shown in the report and never counts.

export function check(name, status, detail, evidence = []) {
  return { name, status, detail, evidence: evidence.filter(Boolean) };
}

/** A check the rules require: when it comes back not checked, the rule cannot pass. */
export function required(c) {
  return { ...c, required: true };
}

/**
 * Folds a rule's checks into one result. Any failed check fails the rule. A required check
 * that is not checked, or no passed check at all, holds the rule at not checked. Otherwise
 * the rule passes, with `partial` set when an optional check was not checked.
 */
export function ruleResult(checks) {
  const failed = checks.filter((c) => c.status === "fail");
  const passed = checks.filter((c) => c.status === "pass");
  const unchecked = checks.filter((c) => c.status === "not_checked");
  const requiredUnchecked = unchecked.filter((c) => c.required);
  const evidence = [...new Set(checks.flatMap((c) => c.evidence))];
  const name = (list) => list.map((c) => `${c.name}: ${c.detail}`).join("; ");
  if (failed.length > 0) return { status: "fail", reason: name(failed), evidence, checks };
  if (passed.length === 0 || requiredUnchecked.length > 0) {
    return {
      status: "not_checked",
      reason: name(requiredUnchecked.length > 0 ? requiredUnchecked : unchecked),
      evidence,
      checks,
    };
  }
  return {
    status: "pass",
    partial: unchecked.length > 0,
    reason: unchecked.length > 0 ? `not checked: ${name(unchecked)}` : "all checks passed",
    evidence,
    checks,
  };
}

/** A whole rule that could not be checked, with the reason. */
export function notChecked(reason) {
  return { status: "not_checked", reason, evidence: [], checks: [] };
}
