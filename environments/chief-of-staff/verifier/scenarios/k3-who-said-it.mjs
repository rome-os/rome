import { tokensIn } from "../lib/checks.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";

const CHAT = "standup";
const RENAMED_TO = "Teo (on call)";

/**
 * Each commitment carries words no other commitment uses, so an answer that repeats them
 * attributes that commitment. The member at index 1 posts once before and once after a
 * display name change.
 */
const COMMITMENTS = [
  {
    member: 0,
    text: "This week I'm committing to flashing the new bootloader onto buoys 14 through 19.",
    tokens: ["bootloader", "buoys 14"],
  },
  {
    member: 1,
    text: "Commitment for this week: backfill the Saltmarsh salinity tables for Scapa Flow.",
    tokens: ["Scapa Flow"],
  },
  {
    member: 2,
    text: "This week I'll get the harbour-master permit for Stromness pier signed.",
    tokens: ["Stromness", "harbour-master"],
  },
  {
    member: 1,
    afterRename: true,
    text: "One more for this week: I'm rotating the ingest service account for the Hoy station by Thursday.",
    tokens: ["Hoy station"],
  },
];

export default {
  rule: "K3",
  title: "Who said it",
  phase: 1,
  async run(ctx) {
    const { env, team } = ctx;
    const renamed = team.members[1];
    const posted = [];
    for (const commitment of COMMITMENTS) {
      if (commitment.afterRename && !posted.some((p) => p.afterRename)) {
        await env.rename({ as: renamed.account, displayName: RENAMED_TO });
      }
      const id = await env.post({
        as: team.members[commitment.member].account,
        chat: CHAT,
        text: commitment.text,
      });
      posted.push({ ...commitment, id });
    }

    const checks = [];
    for (const [index, member] of team.members.entries()) {
      const asker = team.members[(index + 1) % team.members.length].account;
      const { questionId, reply } = await ask(ctx, {
        as: asker,
        chat: CHAT,
        text: `What did ${member.name} commit to this week?`,
      });
      const own = posted.filter((p) => p.member === index);
      const others = posted.filter((p) => p.member !== index);
      const evidence = [questionId, reply?.id, ...posted.map((p) => p.id)];
      if (!reply) {
        checks.push(check(member.name, "fail", "no reply within the reply wait", evidence));
        continue;
      }
      const missing = own.filter((p) => tokensIn(reply.text, p.tokens).length === 0);
      const misattributed = others.filter((p) => tokensIn(reply.text, p.tokens).length > 0);
      const problems = [
        ...missing.map((p) => `missed ${p.id}${p.afterRename ? " (posted after the rename)" : ""}`),
        ...misattributed.map((p) => `attributed ${p.id} by ${team.members[p.member].name} to them`),
      ];
      checks.push(
        problems.length > 0
          ? { ...check(member.name, "fail", problems.join("; "), evidence), quote: reply.text }
          : {
              ...check(
                member.name,
                "pass",
                "every commitment theirs, none of anyone else's",
                evidence,
              ),
              quote: reply.text,
            },
      );
    }
    checks.push(
      check(
        "a person with two accounts",
        "not_checked",
        "the environment gives each member one account, so no person has two",
      ),
    );
    await env.rename({ as: renamed.account, displayName: renamed.name });
    return ruleResult(checks);
  },
};
