import { tokensIn } from "../lib/checks.mjs";
import { ask, check, required, ruleResult } from "../lib/scenario.mjs";

// R4: each commitment is said to the agent, mentioning it, in the chat where the question about
// it is asked later. Phase 1 agents hear only messages that mention them.
const GROUP_CHAT = "general";
const RENAMED_TO = "Teo (on call)";
const SECOND_ACCOUNT_NAME = "Mari (laptop)";

/**
 * K3 is reported in four legs, each with its own commitments. Every commitment carries words no
 * other commitment uses, so an answer that repeats them attributes that commitment.
 * - single-member chat: said in the member's private chat with the agent, asked there.
 * - group chat: one commitment from each member in general, each mentioning the agent.
 * - changed display name: said in general by member 1 after their display name changes.
 * - two accounts: said in general by member 0 from a second account of the same person.
 */
const LEGS = {
  single: "single-member chat",
  group: "group chat",
  renamed: "changed display name",
  twoAccounts: "two accounts",
};

const SINGLE = {
  member: 2,
  text: "My commitment this week: walking the Rackwick cable route with the survey team.",
  tokens: ["Rackwick"],
};

const GROUP = [
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
];

const RENAMED = {
  member: 1,
  text: "One more for this week: I'm rotating the ingest service account for the Hoy station by Thursday.",
  tokens: ["Hoy station"],
};

const SECOND_ACCOUNT = {
  member: 0,
  text: "From my spare account: I'm also writing the Kelpie-7 flashing runbook for the field team.",
  tokens: ["flashing runbook"],
};

/**
 * Grades one leg: each of its commitments must appear in the answer about its own member and
 * in no answer about anyone else.
 */
function gradeLeg(name, commitments, answers, team) {
  const evidence = [
    ...commitments.map((c) => c.id),
    ...answers.flatMap((a) => [a.questionId, a.reply?.id]),
  ];
  const problems = [];
  for (const c of commitments) {
    const own = answers.find((a) => a.member === c.member);
    if (!own?.reply) problems.push(`no answer about ${team.members[c.member].name}`);
    else if (tokensIn(own.reply.text, c.tokens).length === 0) {
      problems.push(`${c.id} missing from the answer about ${team.members[c.member].name}`);
    }
    for (const other of answers.filter((a) => a.member !== c.member && a.reply)) {
      if (tokensIn(other.reply.text, c.tokens).length > 0) {
        problems.push(
          `${c.id} by ${team.members[c.member].name} attributed to ${team.members[other.member].name}`,
        );
      }
    }
  }
  return problems.length > 0
    ? check(name, "fail", problems.join("; "), evidence)
    : check(
        name,
        "pass",
        "every commitment attributed to its own member and nobody else",
        evidence,
      );
}

export default {
  rule: "K3",
  title: "Who said it",
  phase: 1,
  legs: Object.values(LEGS),
  async run(ctx) {
    const { env, team } = ctx;
    const account = (i) => team.members[i].account;

    // Says a commitment to the agent and waits for it to take it in. Without `chat`, it is
    // said in the member's private chat.
    const say = async (as, chat, text) =>
      (await ask(ctx, { as, chat, text, statement: true })).questionId;

    const single = { ...SINGLE, id: await say(account(SINGLE.member), undefined, SINGLE.text) };

    const group = [];
    for (const c of GROUP)
      group.push({ ...c, id: await say(account(c.member), GROUP_CHAT, c.text) });

    await env.rename({ as: account(RENAMED.member), displayName: RENAMED_TO });
    const renamed = {
      ...RENAMED,
      id: await say(account(RENAMED.member), GROUP_CHAT, RENAMED.text),
    };

    // One person, two accounts. When cos-env cannot post from a second account, this leg
    // stays unchecked and K3 cannot pass.
    let second = null;
    let secondError = null;
    try {
      const secondAccount = `${account(SECOND_ACCOUNT.member)}:2`;
      await env.rename({ as: secondAccount, displayName: SECOND_ACCOUNT_NAME });
      second = {
        ...SECOND_ACCOUNT,
        id: await say(secondAccount, GROUP_CHAT, SECOND_ACCOUNT.text),
      };
    } catch (error) {
      secondError = error.message;
    }

    // One question per member in the group chat, each from another member.
    const answers = [];
    for (const [index, member] of team.members.entries()) {
      const asked = await ask(ctx, {
        as: account((index + 1) % team.members.length),
        chat: GROUP_CHAT,
        text: `What did ${member.name} commit to this week?`,
      });
      answers.push({ member: index, ...asked });
    }
    const privateAnswer = {
      member: SINGLE.member,
      ...(await ask(ctx, {
        as: account(SINGLE.member),
        text: `What did ${team.members[SINGLE.member].name} commit to this week?`,
      })),
    };
    await env.rename({
      as: account(RENAMED.member),
      displayName: team.members[RENAMED.member].name,
    });

    const checks = [
      gradeLeg(LEGS.single, [single], [privateAnswer], team),
      gradeLeg(LEGS.group, group, answers, team),
      gradeLeg(LEGS.renamed, [renamed], answers, team),
      second
        ? gradeLeg(LEGS.twoAccounts, [second], answers, team)
        : required(
            check(
              LEGS.twoAccounts,
              "not_checked",
              `cos-env could not post from a second account: ${secondError}`,
            ),
          ),
    ];
    const result = ruleResult(checks);
    result.answers = [...answers, privateAnswer].map((a) => ({
      about: team.members[a.member].name,
      questionId: a.questionId,
      replyId: a.reply?.id ?? null,
      text: a.reply?.text ?? null,
    }));
    return result;
  },
};
