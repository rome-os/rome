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
 * checks all pass except some not checked passes with `partial` set, and the report names
 * the parts not checked.
 */
export function ruleResult(checks) {
  const failed = checks.filter((c) => c.status === "fail");
  const passed = checks.filter((c) => c.status === "pass");
  const unchecked = checks.filter((c) => c.status === "not_checked");
  const evidence = [...new Set(checks.flatMap((c) => c.evidence))];
  if (failed.length > 0) {
    return {
      status: "fail",
      reason: failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
      evidence,
      checks,
    };
  }
  if (passed.length === 0) {
    return {
      status: "not_checked",
      reason: unchecked.map((c) => `${c.name}: ${c.detail}`).join("; "),
      evidence,
      checks,
    };
  }
  return {
    status: "pass",
    partial: unchecked.length > 0,
    reason:
      unchecked.length > 0
        ? `not checked: ${unchecked.map((c) => `${c.name}: ${c.detail}`).join("; ")}`
        : "all checks passed",
    evidence,
    checks,
  };
}

/** Maps a judge's verdict to a check, keeping the verdict and its reasons as evidence. */
export function judged(name, verdict, evidence, quote) {
  const status =
    verdict.verdict === "pass" ? "pass" : verdict.verdict === "fail" ? "fail" : "not_checked";
  const { prompt: _prompt, ...kept } = verdict;
  return { ...check(name, status, `judge: ${verdict.reasons}`, evidence), judge: kept, quote };
}
