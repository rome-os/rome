#!/usr/bin/env node
// The injection side of the chief of staff environment, for COS_TRANSPORT=inject.
// It stands in for Discord, which this mode does without. A member's message
// goes to the app's test-only record route, the same `record_message` call the
// app's Discord hearing makes. The app's stub send step keeps the agent's
// replies. cos-env and env.sh call it, and its output has the same shapes as
// discord.mjs's.
//
//   COS_STATE     the injection state file env.sh keeps (chat ids, display names, messages)
//   COS_ROME      the Rome container
//   COS_APP       the app id
//   COS_PLAN      JSON {chat: [member, ...]}, the members each chat has

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Discord's epoch, so ids made here read like Discord's and sort by time.
const EPOCH = 1420070400000n;
const BOND_WORDS = {
  guardian: "guardian",
  "inner-circle": "inner circle",
  acquaintance: "acquaintance",
  other: "other",
};
// The stand-ins for the Discord ids that only one exists of.
const AGENT_ID = "1000000000000000001";
const DRIVER_ID = "1000000000000000002";
// The connection and account a message arrived on. No Discord connection
// exists in this mode, so these are names only.
const CONNECTION = "inject";

function die(message) {
  process.stderr.write(`cos-env: ${message}\n`);
  process.exit(1);
}

function state() {
  const file = process.env.COS_STATE;
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function saveState(s) {
  writeFileSync(process.env.COS_STATE, `${JSON.stringify(s)}\n`, { mode: 0o600 });
}

// A Discord-style id for now: the milliseconds since Discord's epoch, then
// random low bits so two ids made in the same millisecond differ.
function snowflake(ms = Date.now()) {
  const low = BigInt(Math.floor(Math.random() * 2 ** 22));
  return (((BigInt(ms) - EPOCH) << 22n) | low).toString();
}

function timeOf(id) {
  return new Date(Number((BigInt(id) >> 22n) + EPOCH)).toISOString();
}

function api(method, path, body) {
  const args = [
    "exec",
    "-i",
    process.env.COS_ROME,
    "curl",
    "-sS",
    "--fail-with-body",
    "-X",
    method,
  ];
  if (body !== undefined) {
    args.push("-H", "Content-Type: application/json", "--data-binary", "@-");
  }
  args.push("-H", "Sec-Fetch-Site: same-origin", `http://127.0.0.1:4141/api${path}`);
  let out;
  try {
    out = execFileSync("docker", args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    die(`${method} ${path} failed: ${(error.stdout || error.stderr || error.message).trim()}`);
  }
  return out ? JSON.parse(out) : null;
}

function plan() {
  return JSON.parse(process.env.COS_PLAN ?? "{}");
}

// The member's stand-in account: member1 and member1:2 are two accounts.
function accountId(member) {
  const [base, second] = member.split(":");
  return `inject-${base}${second ? `-${second}` : ""}`;
}

function chatId(s, chat) {
  if (!(chat in plan())) die(`no chat "${chat}". Chats: ${Object.keys(plan()).join(", ")}`);
  s.chats ??= {};
  s.chats[chat] ??= snowflake();
  return s.chats[chat];
}

function serverId(s) {
  s.server ??= snowflake();
  return s.server;
}

// Who Rome's people say the account is, as Rome labels a sender.
function sender(account) {
  const people = api("GET", "/people").people ?? [];
  const person = people.find((p) =>
    p.accounts.some((a) => a.channel === "discord" && a.channelUserId === account),
  );
  if (!person) return { personId: null, label: "not linked" };
  return {
    personId: person.id,
    label: `${person.displayName}, ${BOND_WORDS[person.bondLevel] ?? person.bondLevel}`,
  };
}

function record(s, { member, chat, thread, mention, text }) {
  const driver = member === "driver";
  const base = member.split(":")[0];
  if (!driver && !(plan()[chat] ?? []).includes(base)) die(`${base} is not in #${chat}`);
  let parent = chatId(s, chat);
  if (thread) {
    // A thread is named by the message it starts from, as on Discord.
    const start = (s.messages ?? []).find((m) => m.id === thread || m.thread === thread);
    if (!start) die(`no message ${thread} to start a thread from`);
    if (s.chats[chat] !== start.chatId) die(`message ${thread} is not in #${chat}`);
    parent = start.chatId;
  }
  const id = snowflake();
  const saidAt = timeOf(id);
  const account = driver ? DRIVER_ID : accountId(member);
  const who = driver ? { personId: null, label: "not linked" } : sender(account);
  const name = driver ? "driver" : (s.members?.[member]?.name ?? s.members?.[base]?.name ?? base);
  // Another bot's mention is never a ping, as the app reads Discord.
  const addressed = mention === "agent" && !driver;
  api("POST", `/apps/${process.env.COS_APP}/debug/record-message`, {
    platform: "discord",
    channel: CONNECTION,
    accountId: AGENT_ID,
    serverId: serverId(s),
    chatId: parent,
    threadId: thread || null,
    placeName: thread ? "thread" : chat,
    placeKind: "group",
    senderId: account,
    senderName: name,
    senderPersonId: who.personId,
    senderLabel: who.label,
    saidAt,
    platformMessageId: id,
    text,
    addressed,
  });
  s.messages ??= [];
  s.messages.push({
    id,
    chatId: parent,
    thread: thread || null,
    author: driver ? "driver" : base,
    authorId: account,
    text: mention === "agent" ? `<@${AGENT_ID}> ${text}` : text,
    time: saidAt,
  });
  saveState(s);
  return { id, timestamp: saidAt };
}

function mentionOf(value) {
  return value === "1" || value === true ? "agent" : value === "0" || value === false ? "" : value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const commands = {
  // Prints the stand-in accounts of each member, as JSON {member: [account, ...]}.
  async accounts(...members) {
    const out = {};
    for (const member of members) out[member] = [accountId(member)];
    out.member1?.push(accountId("member1:2"));
    process.stdout.write(`${JSON.stringify(out)}\n`);
  },

  async post(member, chat, thread, mention, text) {
    if (mentionOf(mention) === "second") die("injection mode has no second bot");
    const s = state();
    process.stdout.write(
      `${record(s, { member, chat, thread, mention: mentionOf(mention), text }).id}\n`,
    );
  },

  async replay(file, gap, span) {
    const script = JSON.parse(readFileSync(file, "utf8"));
    const messages = Array.isArray(script) ? script : script.messages;
    if (!Array.isArray(messages)) die(`${file} lists no messages`);
    const started = Date.now();
    for (const [i, m] of messages.entries()) {
      if (i > 0) await sleep(Number(gap) * 1000);
      if (!m.as || !m.chat || !m.text) die(`message ${i} of ${file} needs as, chat and text`);
      const sent = record(state(), {
        member: m.as,
        chat: m.chat,
        thread: m.thread ?? "",
        mention: mentionOf(m.mention ?? ""),
        text: m.text,
      });
      process.stdout.write(
        `${JSON.stringify({ index: i, id: sent.id, as: m.as, chat: m.chat, mention: m.mention ?? false, at: sent.timestamp })}\n`,
      );
    }
    const left = Number(span) * 1000 - (Date.now() - started);
    if (left > 0) await sleep(left);
  },

  // Every message in the chat and its threads, or in one thread, after
  // `since`, oldest first: the members' as injected and the agent's replies
  // as the stub send step kept them.
  async read(chat, thread, since) {
    const s = state();
    const after = since ? BigInt(since) : -1n;
    const replies = (api("GET", `/apps/${process.env.COS_APP}/debug/sent`).replies ?? []).map(
      (r) => ({
        id: r.id,
        chatId: r.chatId,
        thread: r.threadId ?? null,
        author: "agent",
        authorId: AGENT_ID,
        text: r.text,
        time: r.sentAt ?? timeOf(r.id),
        replyTo: r.replyTo ?? null,
      }),
    );
    const all = [...(s.messages ?? []).map((m) => ({ ...m, replyTo: null })), ...replies];
    const parent = chat ? chatId(s, chat) : null;
    const picked = all
      .filter((m) => (thread ? m.thread === thread : m.chatId === parent))
      .filter((m) => BigInt(m.id) > after)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .map(({ id, author, authorId, text, thread: t, time, replyTo }) => ({
        id,
        author,
        authorId,
        text,
        thread: t,
        time,
        replyTo,
        reactions: [],
      }));
    process.stdout.write(`${JSON.stringify(picked, null, 2)}\n`);
  },

  // Prints the chat's id, as the app hears it.
  async chat(name) {
    const s = state();
    const id = chatId(s, name);
    saveState(s);
    process.stdout.write(`${id}\n`);
  },

  // Prints the server id the chat is in, the one every test chat shares.
  async server(chat) {
    const s = state();
    chatId(s, chat);
    const id = serverId(s);
    saveState(s);
    process.stdout.write(`${id}\n`);
  },

  // Sets the display name a member's later messages carry.
  async rename(member, name) {
    const s = state();
    s.members ??= {};
    s.members[member] = { ...s.members[member], name };
    saveState(s);
  },

  // Sets how the app's stub send step answers: stub, fail, hang or platform.
  async send(mode) {
    api("PUT", `/apps/${process.env.COS_APP}/debug/send`, { mode });
  },

  // Forgets the chats' messages and display names, for a reset.
  async clear() {
    const s = state();
    delete s.messages;
    delete s.members;
    saveState(s);
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) die(`unknown inject command "${command}"`);
commands[command](...args).catch((error) => die(error.message));
