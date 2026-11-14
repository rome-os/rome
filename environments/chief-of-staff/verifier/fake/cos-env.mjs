#!/usr/bin/env node
// A fake `cos-env` for the verifier's own tests: the same commands, with a scripted stand-in
// agent instead of Discord and Rome. State lives in the JSON file COS_FAKE_STATE. The
// stand-in is COS_FAKE_AGENT: "good", or "fail-<rule>" to break exactly that rule.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { respond } from "./stand-in.mjs";

const statePath = process.env.COS_FAKE_STATE;
if (!statePath) {
  console.error("COS_FAKE_STATE is not set");
  process.exit(2);
}
const agent = process.env.COS_FAKE_AGENT ?? "good";

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
  };
  state.messages.push(message);
  return message;
}

function agentTurn(message) {
  const out = respond({ agent, state, message });
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
    } else if (message.mentionsAgent) agentTurn(message);
    console.log(message.id);
    break;
  }
  case "dm": {
    const message = add({
      chat: `dm-${values.as}`,
      author: values.as,
      text: positionals.join(" "),
    });
    agentTurn(message);
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
    if (positionals[0] === "restart" || positionals[0] === "start") state.restarts += 1;
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
save();
