#!/usr/bin/env node
// A fake `cos-env` for the verifier's own tests: the same commands, with a scripted stand-in
// agent instead of Discord and Rome. State lives in the JSON file COS_FAKE_STATE. The
// stand-in is COS_FAKE_AGENT: "good", or "fail-<rule>" to break exactly that rule.
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { goalsDocument, respond, rosterDocument } from "./stand-in.mjs";

const statePath = process.env.COS_FAKE_STATE;
if (!statePath) {
  console.error("COS_FAKE_STATE is not set");
  process.exit(2);
}
const agent = process.env.COS_FAKE_AGENT ?? "good";

// The verifier runs some commands at once, as K5 does, and each one reads and rewrites the
// whole state file, so one command holds the state at a time.
const lockPath = `${statePath}.lock`;
for (;;) {
  try {
    mkdirSync(lockPath);
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
process.on("exit", () => rmdirSync(lockPath));

const fresh = () => ({
  nextId: 1000,
  clock: Date.parse("2026-11-13T09:00:00Z"),
  messages: [],
  displayNames: {},
  team: null,
  restarts: 0,
  privateNotes: [],
});
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : fresh();
const save = () => writeFileSync(statePath, JSON.stringify(state));

function add({ chat, thread = null, author, text, delaySeconds = 3, mentionsAgent = false }) {
  state.clock += delaySeconds * 1000;
  const message = {
    id: String(state.nextId++),
    chat,
    thread,
    author,
    displayName: author === "agent" ? "Chief of staff" : (state.displayNames[author] ?? author),
    text,
    time: new Date(state.clock).toISOString(),
    mentionsAgent,
    offline: Boolean(state.stopped),
  };
  state.messages.push(message);
  return message;
}

function agentTurn(message, catchUp = false) {
  // As Rome records it: the SDK's running total for the session, not the turn's own cost.
  const total = (state.turns ?? []).at(-1)?.costUsd ?? 0;
  state.turns = [
    ...(state.turns ?? []),
    {
      start: new Date().toISOString(),
      turnId: `turn-${(state.turns ?? []).length + 1}`,
      sessionId: "server",
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      costUsd: +(total + 0.001).toFixed(6),
    },
  ];
  const out = respond({ agent, state, message, catchUp });
  if (!out) return;
  if (out.held) {
    state.held = [
      ...(state.held ?? []),
      { status: "pending", question: out.question, reply: out.text, reason: "held for approval" },
    ];
    return;
  }
  const clock = state.clock;
  state.clock = Date.parse(message.time);
  add({
    chat: out.chat,
    thread: out.thread,
    author: "agent",
    text: out.text,
    delaySeconds: out.delaySeconds,
  });
  state.clock = Math.max(clock, state.clock);
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    as: { type: "string" },
    chat: { type: "string" },
    dm: { type: "string" },
    thread: { type: "string" },
    since: { type: "string" },
    "mention-agent": { type: "boolean", default: false },
  },
});

switch (command) {
  case "version":
    console.log(
      JSON.stringify({
        rome: { commit: "fake-rome", dirty: false },
        agent: { commit: `fake-${agent}`, dirty: false },
        environment: { commit: "fake-environment", dirty: false },
        verifier: { commit: "fake-verifier", dirty: false },
        app: { repo: "fake/chief-of-staff", ref: "main", commit: `fake-${agent}`, dirty: false },
        model: { login: "scripted stand-in", tierModelMappings: null },
        memory: { current: { since: `start-${state.romeStarts ?? 0}` } },
      }),
    );
    break;
  case "reset":
    Object.assign(state, fresh());
    break;
  case "seed":
    state.team = JSON.parse(readFileSync(join(positionals[0], "team.json"), "utf8"));
    break;
  case "rename":
    state.displayNames[values.as] = positionals.join(" ");
    break;
  case "post": {
    // Strict like the real cos-env: a member posts only in chats they can read.
    const readers = state.team?.chats?.[values.chat]?.readers;
    if (readers && !readers.includes(values.as.split(":")[0])) {
      console.error(`cos-env: ${values.as} is not in #${values.chat}`);
      process.exit(2);
    }
    // Stand in for an environment where only posting from a second account fails.
    if (values.as.includes(":") && process.env.COS_FAKE_NO_SECOND_ACCOUNT) {
      console.error("a second account is not available");
      process.exit(2);
    }
    const message = add({
      chat: values.chat,
      thread: values.thread ?? null,
      author: values.as,
      text: positionals.join(" "),
      mentionsAgent: values["mention-agent"],
    });
    // COS_FAKE_RESTART_ON: the first message containing it is lost to a Rome restart.
    const lostTo = process.env.COS_FAKE_RESTART_ON;
    if (lostTo && message.text.includes(lostTo) && !state.lostOnce) {
      state.lostOnce = true;
      state.romeStarts = (state.romeStarts ?? 0) + 1;
    } else if (!state.stopped) agentTurn(message);
    console.log(message.id);
    break;
  }
  case "dm": {
    const message = add({
      chat: `dm-${values.as}`,
      author: values.as,
      text: positionals.join(" "),
    });
    if (!state.stopped) agentTurn(message);
    console.log(message.id);
    break;
  }
  case "read": {
    // Strict like the real cos-env: a read names a chat or a member.
    if (!values.dm && !values.chat) {
      console.error("usage: cos-env read --chat <name> | --dm <member>");
      process.exit(2);
    }
    const chat = values.dm ? `dm-${values.dm}` : values.chat;
    const since = values.since ? Number(values.since) : -1;
    const found = state.messages
      .filter((m) => m.chat === chat && Number(m.id) > since)
      .filter((m) => !values.thread || m.thread === values.thread)
      .map(({ id, author, text, thread, time }) => ({
        id,
        author,
        text,
        thread,
        time,
        reactions: [],
      }));
    console.log(JSON.stringify(found));
    break;
  }
  case "clock":
    // "clock forward <hours>": the agent's clock, and the messages after it, move ahead.
    state.clock += Number(positionals[1]) * 3600 * 1000;
    state.dayMovedAt = state.nextId;
    break;
  case "doc":
    console.log(
      positionals[0] === "roster" ? rosterDocument(state, agent) : goalsDocument(state, agent),
    );
    break;
  case "memory":
    console.log(JSON.stringify({ files: [], toolUses: [] }));
    break;
  case "usage":
    for (const turn of state.turns ?? []) console.log(JSON.stringify(turn));
    break;
  case "logs":
    mkdirSync(positionals[0], { recursive: true });
    writeFileSync(join(positionals[0], "rome.log"), `fake logs since ${values.since}\n`);
    break;
  case "rome":
    // renew-session keeps the agent's knowledge; only a restart or a cold start re-wakes it.
    if (positionals[0] === "renew-session" && process.env.COS_FAKE_NO_RENEW) {
      console.error("renewing the session needs a core change");
      process.exit(2);
    }
    if (positionals[0] === "held") {
      console.log(JSON.stringify(state.held ?? []));
      break;
    }
    if (positionals[0] === "stop") state.stopped = true;
    if (positionals[0] === "restart" || positionals[0] === "start") state.restarts += 1;
    // Back from a stop, the agent reads what was said while Rome was down.
    if (positionals[0] === "start" && state.stopped) {
      state.stopped = false;
      for (const m of state.messages.filter((x) => x.offline && x.mentionsAgent))
        agentTurn(m, true);
    }
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
save();
