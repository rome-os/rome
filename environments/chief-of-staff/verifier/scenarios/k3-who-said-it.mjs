import { tokensIn } from "../lib/checks.mjs";
import { ask, check, required, ruleResult } from "../lib/scenario.mjs";

const CHAT = "standup";
const RENAMED_TO = "Teo (on call)";
const SECOND_ACCOUNT_NAME = "Mari (laptop)";

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

// A commitment the member at index 0 posts from a second Discord account of the same person.
const SECOND_ACCOUNT_COMMITMENT = {
  member: 0,
  text: "From my spare account: I'm also writing the Kelpie-7 flashing runbook for the field team.",
  tokens: ["flashing runbook"],
};

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

    // One person, two accounts. When cos-env cannot post from a second account, the
    // two-account part of the rule stays unchecked and K3 cannot pass.
    const secondAccount = `${team.members[0].account}:2`;
    let twoAccountCheck;
    try {
      await env.rename({ as: secondAccount, displayName: SECOND_ACCOUNT_NAME });
      const id = await env.post({
        as: secondAccount,
        chat: CHAT,
        text: SECOND_ACCOUNT_COMMITMENT.text,
      });
      posted.push({ ...SECOND_ACCOUNT_COMMITMENT, id, secondAccount: true });
    } catch (error) {
      twoAccountCheck = required(
        check(
          "a person with two accounts",
          "not_checked",
          `cos-env could not post from a second account: ${error.message}`,
        ),
      );
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
        ...missing.map(
          (p) =>
            `missed ${p.id}${p.afterRename ? " (posted after the rename)" : ""}${p.secondAccount ? " (posted from the second account)" : ""}`,
        ),
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
    if (twoAccountCheck) checks.push(twoAccountCheck);
    await env.rename({ as: renamed.account, displayName: renamed.name });
    return ruleResult(checks);
  },
};
