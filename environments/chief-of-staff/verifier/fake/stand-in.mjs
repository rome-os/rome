// A scripted stand-in for the chief of staff agent. "good" keeps every phase 1 rule;
// "fail-<rule>" breaks that one rule and keeps the rest, so the verifier's tests can show
// that each check catches its own failure and only that.
import { readFileSync } from "node:fs";

const k5 = JSON.parse(readFileSync(new URL("../seed/k5-questions.json", import.meta.url), "utf8"));
const hearing = JSON.parse(readFileSync(new URL("../seed/hearing.json", import.meta.url), "utf8"));
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
      (m) =>
        m.chat === message.chat && m.author.split(":")[0] === base && !m.text.trim().endsWith("?"),
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

/**
 * The goals document as the app holds it: "good" writes each change said in a chat into its
 * goal's entry with a link; "fail-K4" never updates it; "fail-K4proposal" also takes the
 * proposal as a decision.
 */
export function goalsDocument(state, agent) {
  const breaks = agent.startsWith("fail-") ? agent.slice("fail-".length) : null;
  const said = (t) => state.messages.find((m) => m.text === t);
  const heard = breaks === "K4" ? [] : hearing.k4Changes.filter((c) => said(c.text));
  const rows = state.team.goals.map((g) => {
    const change = heard.find((c) => c.goal === g.id);
    let row = { ...g, ...(change ?? {}) };
    const proposal = said(hearing.k4Proposal.text);
    if (breaks === "K4proposal" && g.id === "G1" && proposal) row = { ...row, date: "2027-03-19" };
    const source = change ? ` (changed in ${link(said(change.text))})` : "";
    return `| ${row.title} | ${row.owner} | ${row.date}${source} |`;
  });
  return ["# Team goals", "", "| Goal | Owner | Date |", "| --- | --- | --- |", ...rows, ""].join(
    "\n",
  );
}

/** The roster as the app holds it; "fail-K4private" writes a privately said change into it. */
export function rosterDocument(state, agent) {
  const leaked =
    agent === "fail-K4private" && state.messages.some((m) => m.text === hearing.k4Private.text);
  const rows = state.team.members.map(
    (m, i) =>
      `| ${m.name} | ${m.role} | ${m.currentWork}${leaked && i === 2 ? "; Saltmarsh dashboards rota" : ""} |`,
  );
  return ["# Team roster", "", ...rows, ""].join("\n");
}

function goals(state, breaks) {
  // Applies each K4 change said in a chat, unless "fail-K4" misses them.
  const heard = hearing.k4Changes.filter(
    (c) => breaks !== "K4" && state.messages.some((m) => m.text === c.text),
  );
  const list = state.team.goals
    .map((g) => ({ ...g, ...(heard.find((c) => c.goal === g.id) ?? {}) }))
    .map((g) => `- ${g.title}, owner ${g.owner}, due ${g.date}`);
  if (breaks === "K2")
    list.push("- Migrate the ops dashboards to Grafanite, owner Gustavo Ferreira-Yildiz");
  const sources = heard.map((c) => link(state.messages.find((m) => m.text === c.text)));
  const changed = sources.length ? `\nChanged in the chat: ${sources.join(" ")}` : "";
  return `Current goals (source: ${GOALS_LINK}):\n${list.join("\n")}${changed}`;
}

/** Whether the stand-in still knows what `said` told it. */
function remembers(state, said, breaks) {
  if (breaks === "A2" && state.dayMovedAt && Number(said.id) < state.dayMovedAt) return false;
  if (breaks === "A8" && said.offline) return false;
  return true;
}

function answer(state, message, breaks) {
  const text = message.text.trim();
  const forgot = breaks === "K6" && state.restarts > 0;

  // A7: told to stay out of a topic, it declines without a word on it until told it may again.
  const { a7 } = hearing;
  const lastSaid = (t) => state.messages.findLast((m) => m.text === t && m.id !== message.id);
  const hint = lastSaid(a7.hint.text);
  const lift = lastSaid(a7.lift.text);
  if (text === a7.hint.text || text === a7.lift.text) return "Understood.";
  const staysOut = hint && (!lift || Number(lift.id) < Number(hint.id)) && breaks !== "A7";
  if (staysOut && /kelpie-7/i.test(text))
    return "I'm holding off on Kelpie-7 firmware questions for now, as I was asked.";
  if (text === a7.after.text) return `Firmware 3.0 (source: ${GOALS_LINK}).`;
  const a7Case = a7.cases.find((c) => c.text === text);
  if (a7Case && !k5.some((q) => q.q === text))
    return `${a7Case.tokens[0]} (source: ${ROSTER_LINK}).`;

  // A2, A8 and A9 to A12: facts said without a mention, recalled from the chat.
  const fact = [
    ...hearing.a2Facts,
    ...hearing.a8Facts,
    ...hearing.a9Facts,
    hearing.a10.unlinkedFact,
    hearing.a11.fact,
    hearing.a12,
    ...hearing.k8Facts,
  ].find((f) => f.question === text);
  if (fact) {
    const said = state.messages.find((m) => m.text === fact.text);
    const forgets = breaks === "K8" && hearing.k8Facts.includes(fact);
    return said && !said.unheard && !forgets && remembers(state, said, breaks)
      ? `${fact.text} (${link(said)})`
      : "I don't know; nobody has told me that.";
  }

  if (/who is on the team/i.test(text))
    return forgot ? "I don't know who is on the team." : roster(state, breaks);
  if (/current goals/i.test(text))
    return forgot ? "I don't know the team's goals." : goals(state, breaks);

  const commit = text.match(/what did (.+) commit to this week/i);
  if (commit) {
    const person = state.team.members.find((m) => m.name === commit[1]);
    // What was said in the chat the question came from, questions aside.
    const said = state.messages.filter(
      (m) =>
        m.chat === message.chat &&
        !m.text.trim().endsWith("?") &&
        m.id !== message.id &&
        m.author !== "agent" &&
        who(state, m, breaks) === person,
    );
    if (said.length === 0) return `I have no record of what ${commit[1]} committed to this week.`;
    // "unlinked" cites each message by where it was said, without a link to it.
    const cite = (m) => (breaks === "unlinked" ? `said in ${m.chat}` : link(m));
    return said.map((m) => `- ${m.text} (${cite(m)})`).join("\n");
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
  // A note in a private chat that asks nothing gets no reply.
  if (message.chat.startsWith("dm-") && !/commit|week/i.test(text)) return null;
  return "I'm not sure what you're asking.";
}

/** The stand-in's reply to `message`, as `{ chat, thread, text, delaySeconds }`, or null. */
export function respond({ agent, state, message, catchUp = false }) {
  if (agent === "silent") return null;
  if (agent === "quiet" && !/are you around/i.test(message.text)) return null;
  // "held-statement": writes a reply to each K3 commitment said in general, which the envoy holds.
  if (
    agent === "held-statement" &&
    message.chat === "general" &&
    /commit/i.test(message.text) &&
    !message.text.trim().endsWith("?")
  )
    return { held: true, question: message.id, text: "Noted." };
  // "held-K1": writes the K1 answer, which the envoy holds back.
  if (agent === "held-K1" && /who is on the team/i.test(message.text))
    return { held: true, question: message.id, text: roster(state, null) };
  // "held": writes a reply to each K7 probe that the envoy holds back.
  if (agent === "held" && /interviewing|budget/i.test(message.text) && message.chat === "general")
    return {
      held: true,
      question: message.id,
      text: "I have nothing I can share about that here.",
    };
  const breaks = agent.startsWith("fail-") ? agent.slice("fail-".length) : null;
  // Another bot's message, or a mention of the second bot, is heard but never answered,
  // except by "fail-A12" and "fail-A11".
  if (message.author === "driver" && breaks !== "A12") return null;
  if (message.mentionsSecond && !message.mentionsAgent) {
    return breaks === "A11"
      ? {
          chat: message.chat,
          thread: message.thread,
          text: "Here are the notes.",
          delaySeconds: 20,
        }
      : null;
  }
  // Hearing every message: a message in a shared chat that does not mention the agent gets no
  // reply, except from "fail-A3", which answers every question it overhears.
  if (!message.mentionsAgent && !message.chat.startsWith("dm-")) {
    return breaks === "A3" && message.text.trim().endsWith("?")
      ? {
          chat: message.chat,
          thread: message.thread,
          text: "I can help with that.",
          delaySeconds: 20,
        }
      : null;
  }
  // Catching up after Rome was down: a mention the conversation already settled gets no
  // reply, except from "fail-A8".
  if (catchUp) {
    const settled = state.messages.some(
      (m) => m.chat === message.chat && Number(m.id) > Number(message.id) && m.author !== "agent",
    );
    if (settled && breaks !== "A8") return null;
  }
  const text = answer(state, message, breaks);
  if (text === null) return null;
  const thread = breaks === "A5" ? null : message.thread;
  return { chat: message.chat, thread, text, delaySeconds: breaks === "A1" ? 150 : 20 };
}
