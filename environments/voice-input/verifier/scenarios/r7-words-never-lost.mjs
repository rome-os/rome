// Rule 7: whatever stops listening, the words heard so far are in the field when the guardian
// comes back, and the field says why within 5 seconds. On the dashboard the checked stops are
// opening another chat, reloading the page, losing the network and an error from the
// transcriber; putting the iOS app in the background is phase 3.
import { check, required, ruleResult } from "../lib/scenario.mjs";
import { NOTICE_MS, runStops, wordsKept } from "../lib/stops.mjs";

export default {
  rule: "7",
  title: "Words you said are never lost",
  phase: 2,
  async run(ctx) {
    const { message, outcomes } = await runStops(ctx);
    return ruleResult(outcomes.map((o) => required(stopCheck(o, message))));
  },
};

function stopCheck(o, message) {
  const name = `${o.kind}`;
  if (o.error)
    return check(name, "not_checked", `could not run the stop: ${o.error}`, [message.key]);
  if (!o.before.trim())
    return check(name, "not_checked", "no words were in the field before the stop", [message.key]);
  const words = wordsKept(o.before, o.after, message.language);
  const problems = [];
  if (!words.kept)
    problems.push(
      `before the stop the field held "${o.before}", afterwards "${o.after}" (${words.wrong} of ${words.of} words missing or changed)`,
    );
  if (o.notice === null) problems.push(`no notice within ${NOTICE_MS / 1000} s`);
  else if (o.noticeMs > NOTICE_MS)
    problems.push(`the notice "${o.notice}" came after ${(o.noticeMs / 1000).toFixed(1)} s`);
  else if (o.notice && o.expected && o.notice !== o.expected)
    problems.push(`the notice says "${o.notice}", the contract gives "${o.expected}"`);
  return check(
    name,
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? `kept "${o.after.trim()}" (heard before the stop: "${o.before.trim()}"); notice "${o.notice}" after ${(o.noticeMs / 1000).toFixed(1)} s; transcriber: ${o.transcriber}`
      : `${problems.join("; ")}; transcriber: ${o.transcriber}`,
    [message.key],
  );
}
