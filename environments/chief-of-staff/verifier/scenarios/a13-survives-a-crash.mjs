import { agentMessagesSince, waitForAgent } from "../lib/checks.mjs";
import { loadHearing, sleep } from "../lib/hearing.mjs";
import { check, ruleResult } from "../lib/scenario.mjs";

/** How long after the first reply a second copy of it would still count, at most. */
const DUPLICATE_WAIT_MS = 60_000;

const count = (text, word) => String(text ?? "").split(word).length - 1;

/**
 * For turn-as-one-commit (design thread, 2026-11-18): the app's worker is killed at each point
 * between a turn's writes, and after Rome restarts the turn's effects land exactly once. Each
 * crash follows a mention that changes the Kelpie-7 goal's date to a new one. The memory and
 * the goals document are read through `cos-env`, the first rule that scores more than the chat.
 */
export default {
  rule: "A13",
  title: "Survives a crash mid-turn",
  phase: 3,
  async run(ctx) {
    const checks = [];
    for (const crash of loadHearing().a13Crashes) {
      const at = `crash ${crash.point}`;
      await ctx.env.crashAt(crash.point);
      const pingId = await ctx.env.post({
        as: crash.as,
        chat: crash.chat,
        mentionAgent: true,
        text: crash.text,
      });
      // The worker exits partway through the turn; give the turn the A1 wait to reach the point.
      await sleep(ctx.waits.a1Ms);
      await ctx.env.rome("restart");
      // Wait for the reply, then a while longer for a second copy of it.
      await waitForAgent(ctx.env, {
        chats: [crash.chat],
        since: pingId,
        timeoutMs: ctx.waits.replyMs,
        pollMs: ctx.waits.pollMs,
      });
      await sleep(Math.min(DUPLICATE_WAIT_MS, ctx.waits.replyMs));

      const replies = await agentMessagesSince(ctx.env, { chats: [crash.chat], since: pingId });
      checks.push(
        check(
          `${at}: one reply to the mention, none lost and none twice`,
          replies.length === 1 ? "pass" : "fail",
          `${replies.length} replies${replies.length ? `: ${replies.map((r) => r.id).join(", ")}` : ""}`,
          [pingId, ...replies.map((r) => r.id)],
        ),
      );

      const { events, outbox } = await ctx.env.handled();
      const twice = Object.entries(events).filter(([, turns]) => turns > 1);
      checks.push(
        check(
          `${at}: no event handled twice`,
          twice.length === 0 ? "pass" : "fail",
          `${twice.length ? `handled more than once: ${twice.map(([id, n]) => `${id} ${n} times`).join(", ")}` : `every event handled at most once`}; the mention's event ${pingId in events ? `${events[pingId]} times` : "not listed by its message id"}; outbox sent ${outbox.sent}, found ${outbox.found}`,
          [pingId],
        ),
      );

      const goals = await ctx.env.doc("goals");
      const inDoc = count(goals, crash.date);
      checks.push(
        check(
          `${at}: the goals document takes the change exactly once`,
          inDoc === 1 ? "pass" : "fail",
          `${crash.date} appears ${inDoc} times in the goals document`,
          [pingId],
        ),
      );

      const memory = (await ctx.env.memoryFiles()).map((f) => f.text).join("\n");
      const entries = memory.split("\n").filter((l) => l.includes(crash.date));
      checks.push(
        check(
          `${at}: no duplicate memory entry`,
          entries.length <= 1 ? "pass" : "fail",
          `${entries.length} memory lines name ${crash.date}${entries.length > 1 ? `: ${entries.join(" | ")}` : ""}`,
          [pingId],
        ),
      );
    }
    return ruleResult(checks);
  },
};
