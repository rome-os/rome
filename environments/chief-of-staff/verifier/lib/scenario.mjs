// What a scenario uses to talk to the agent and to report a rule's result.
import { dmChat } from "./cos-env.mjs";
import { waitForAgent } from "./checks.mjs";

/**
 * Posts `text` as member `as` (in a chat with a mention, in a thread, or as a direct
 * message when `chat` is omitted) and waits for the agent's first message after it in
 * `watch` (default: the chat the question was asked in). Resolves to `{ questionId, reply }`,
 * where `reply` is null when the agent stayed silent past the reply wait.
 */
export async function ask(ctx, { as, chat, thread, text, watch, timeoutMs }) {
  const questionId = chat
    ? await ctx.env.post({ as, chat, thread, mentionAgent: true, text })
    : await ctx.env.dm({ as, text });
  const chats = watch ?? [chat ?? dmChat(as)];
  const reply = await waitForAgent(ctx.env, {
    chats,
    since: questionId,
    timeoutMs: timeoutMs ?? ctx.waits.replyMs,
    pollMs: ctx.waits.pollMs,
  });
  ctx.log(`${as} asked ${questionId}; reply ${reply ? reply.id : "none"}`);
  return { questionId, reply };
}

export function check(name, status, detail, evidence = []) {
  return { name, status, detail, evidence: evidence.filter(Boolean) };
}

/**
 * Folds a rule's checks into one result. Any failed check fails the rule. A rule whose
 * checks all pass except some optional ones not checked passes with `partial` set, and the
 * report names the parts not checked. A check made with `required: true` that comes back not
 * checked holds the whole rule at not checked: the rule does not count as passed while a part
 * the rules require was not run. A check that failed only for want of a design decision
 * (`waits_on_design`) holds the rule at that status unless an agent failure fails it first.
 */
export function ruleResult(checks) {
  const failed = checks.filter((c) => c.status === "fail");
  const waiting = checks.filter((c) => c.status === "waits_on_design");
  const passed = checks.filter((c) => c.status === "pass");
  const unchecked = checks.filter((c) => c.status === "not_checked");
  const requiredUnchecked = unchecked.filter((c) => c.required);
  const evidence = [...new Set(checks.flatMap((c) => c.evidence))];
  const name = (list) => list.map((c) => `${c.name}: ${c.detail}`).join("; ");
  if (failed.length > 0) {
    return { status: "fail", reason: name(failed), evidence, checks };
  }
  if (waiting.length > 0) {
    return { status: "waits_on_design", reason: name(waiting), evidence, checks };
  }
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

/**
 * A check whose failure waits on a design decision rather than counting against the agent.
 * The check itself is unchanged: only a failure is relabelled.
 */
export function waitsOnDesign(check, decision) {
  return check.status === "fail"
    ? {
        ...check,
        status: "waits_on_design",
        detail: `${check.detail} (waits on a design decision: ${decision})`,
      }
    : check;
}

/** A check the rules require: when it comes back not checked, the rule cannot pass. */
export function required(check) {
  return { ...check, required: true };
}

/** Maps a judge's verdict to a check, keeping the verdict and its reasons as evidence. */
export function judged(name, verdict, evidence, quote) {
  const status =
    verdict.verdict === "pass" ? "pass" : verdict.verdict === "fail" ? "fail" : "not_checked";
  const { prompt: _prompt, ...kept } = verdict;
  return { ...check(name, status, `judge: ${verdict.reasons}`, evidence), judge: kept, quote };
}
