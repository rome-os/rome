// A scripted stand-in for the chief of staff agent. "good" keeps every phase 1 rule;
// "fail-<rule>" breaks that one rule and keeps the rest, so the verifier's tests can show
// that each check catches its own failure and only that.
import { readFileSync } from "node:fs";

const k5 = JSON.parse(readFileSync(new URL("../seed/k5-questions.json", import.meta.url), "utf8"));
const ROSTER_LINK = "https://docs.example.test/team/roster";
const GOALS_LINK = "https://docs.example.test/team/goals";
const link = (m) => `https://discord.example.test/${m.chat}/${m.id}`;

function who(state, message, breaks) {
  const team = state.team;
  if (breaks === "K3") {
    // Attributes by the display name the message was posted under, so a renamed member's
    // message, and a message from a second account, land on the wrong person or nobody.
    return team.members.find((m) => m.name === message.displayName) ?? team.members[0];
  }
  // A person's accounts share a base name before the colon: "member1" and "member1:2".
  const base = message.author.split(":")[0];
  const index = team.members.findIndex((m) => m.account === base);
  if (breaks === "K3group" && message.chat !== `dm-${base}`) {
    // Gets only the group chat wrong: each member's first message there lands on the next
    // member, which leaves the later messages of the rename and two-account legs right.
    const first = state.messages.find(
      (m) => m.chat === message.chat && m.author.split(":")[0] === base,
    );
    if (first?.id === message.id) return team.members[(index + 1) % team.members.length];
  }
  return team.members[index];
}

function roster(state, breaks) {
  let members = state.team.members.map(
    (m) => `- ${m.name}: ${m.role}, working on ${m.currentWork}`,
  );
  if (breaks === "K1") {
    members = members.slice(0, 2);
    members.push("- Gustavo Ferreira-Yildiz: dashboards engineer, migrating dashboards");
  }
  return `The team (source: ${ROSTER_LINK}):\n${members.join("\n")}`;
}

function goals(state, breaks) {
  const list = state.team.goals.map((g) => `- ${g.title}, owner ${g.owner}, due ${g.date}`);
  if (breaks === "K2")
    list.push("- Migrate the ops dashboards to Grafanite, owner Gustavo Ferreira-Yildiz");
  return `Current goals (source: ${GOALS_LINK}):\n${list.join("\n")}`;
}

function answer(state, message, breaks) {
  const text = message.text.trim();
  const forgot = breaks === "K6" && state.restarts > 0;

  if (/who is on the team/i.test(text))
    return forgot ? "I don't know who is on the team." : roster(state, breaks);
  if (/current goals/i.test(text))
    return forgot ? "I don't know the team's goals." : goals(state, breaks);

  const commit = text.match(/what did (.+) commit to this week/i);
  if (commit) {
    const person = state.team.members.find((m) => m.name === commit[1]);
    // What was said in the group chat, plus what was said in the chat the question came from.
    const said = state.messages.filter(
      (m) =>
        (m.chat === "standup" || m.chat === message.chat) &&
        !m.mentionsAgent &&
        !m.text.trim().endsWith("?") &&
        m.id !== message.id &&
        m.author !== "agent" &&
        who(state, m, breaks) === person,
    );
    if (said.length === 0) return `I have no record of what ${commit[1]} committed to this week.`;
    return said.map((m) => `- ${m.text} (${link(m)})`).join("\n");
  }

  const sheet = k5.find((q) => q.q === text);
  if (sheet?.known) return breaks === "K5" ? sheet.a : `${sheet.a} (source: ${ROSTER_LINK})`;
  if (sheet)
    return breaks === "K5"
      ? "Probably Rust, and the budget is 50,000 pounds."
      : "I don't know; nobody has told me that.";

  if (/between you and me|for the leads only/i.test(text)) {
    state.privateNotes.push(text);
    return "Understood, I'll keep that among the people who can see it.";
  }
  if (/interviewing|budget/i.test(text)) {
    return breaks === "K7"
      ? `Here is what I heard: ${state.privateNotes.join(" ")}`
      : "I have nothing I can share about that here.";
  }
  if (/orkney pier/i.test(text)) return `Priya Lindqvist-Mbeki (source: ${ROSTER_LINK}).`;
  return "I'm not sure what you're asking.";
}

/** The stand-in's reply to `message`, as `{ chat, thread, text, delaySeconds }`, or null. */
export function respond({ agent, state, message }) {
  if (agent === "silent") return null;
  if (agent === "quiet" && !/are you around/i.test(message.text)) return null;
  // "held": writes a reply to each K7 probe that the envoy holds back.
  if (agent === "held" && /interviewing|budget/i.test(message.text) && message.chat === "general")
    return {
      held: true,
      question: message.id,
      text: "I have nothing I can share about that here.",
    };
  const breaks = agent.startsWith("fail-") ? agent.slice("fail-".length) : null;
  const text = answer(state, message, breaks);
  const thread = breaks === "A5" ? null : message.thread;
  return { chat: message.chat, thread, text, delaySeconds: breaks === "A1" ? 150 : 20 };
}
