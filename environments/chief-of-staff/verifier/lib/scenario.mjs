// What a scenario uses to talk to the agent and to report a rule's result.
import { dmChat } from "./cos-env.mjs";
import { secondsBetween, waitForAgent } from "./checks.mjs";

/**
 * Posts `text` as member `as` (in a chat with a mention, in a thread, or as a direct
 * message when `chat` is omitted) and waits for the agent's first message after it in
 * `watch` (default: the chat the question was asked in). Resolves to `{ questionId, reply }`,
 * where `reply` is null when the agent stayed silent past the reply wait.
 */
export async function ask(ctx, { as, chat, thread, text, watch, timeoutMs, statement = false }) {
  const chats = watch ?? [chat ?? dmChat(as)];
  const once = async () => {
    const startedAt = await romeStartedAt(ctx.env);
    const questionId = chat
      ? await ctx.env.post({ as, chat, thread, mentionAgent: true, text })
      : await ctx.env.dm({ as, text });
    const reply = await waitForAgent(ctx.env, {
      chats,
      since: questionId,
      timeoutMs: timeoutMs ?? ctx.waits.replyMs,
      pollMs: ctx.waits.pollMs,
    });
    const restarted = !reply && startedAt !== (await romeStartedAt(ctx.env));
    return { questionId, reply, restarted };
  };
  // A message posted while Rome restarted may never have reached it. Post it once more after
  // Rome is back; a second miss across a restart is Rome's, not the agent's.
  let { questionId, reply, restarted } = await once();
  if (restarted) {
    const first = questionId;
    ctx.log(`Rome restarted while ${first} waited; posting it again`);
    await sleep(ctx.waits.restartMs ?? 60_000);
    ({ questionId, reply, restarted } = await once());
    ctx.romeEvents?.push({
      rule: ctx.rule ?? "liveness",
      questionId: first,
      repostedAs: questionId,
      outcome: reply ? "answered after the repost" : restarted ? "Rome was down" : "no answer",
    });
  }
  ctx.log(`${as} asked ${questionId}; reply ${reply ? reply.id : "none"}`);
  if (ctx.answered) {
    ctx.answered.sent += 1;
    if (reply) ctx.answered.answered += 1;
  }
  if (ctx.answerTimes) {
    const where = chat ? { chat } : { dm: as };
    const asked = reply ? (await ctx.env.read(where)).find((m) => m.id === questionId) : null;
    ctx.answerTimes.push({
      rule: ctx.rule ?? "liveness",
      // A statement, such as a K3 commitment, is said to the agent but is not a question.
      kind: statement ? "statement" : "question",
      chat: chat ?? dmChat(as).label,
      questionId,
      replyId: reply?.id ?? null,
      seconds: asked ? secondsBetween(asked.time, reply.time) : null,
    });
  }
  return { questionId, reply };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** When Rome's container last started, from `cos-env version`, or null when unknown. */
async function romeStartedAt(env) {
  try {
    return (await env.version()).memory?.current?.since ?? null;
  } catch {
    return null;
  }
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
