#!/usr/bin/env node
// The Discord side of the chief of staff environment, over the Discord REST API
// with no dependency to install. cos-env and env.sh call it. The members are
// webhook authors: each member posts through its own webhook in each chat it is
// in, and one driver bot reads the chats and runs the webhooks. Tokens arrive in
// the environment or the state file, never in argv, since argv shows in `ps`.
//
//   COS_TOKEN               the bot token acting: the driver, or the agent for whoami
//   COS_DISCORD_SERVER_ID   the test server
//   COS_STATE               the state file env.sh writes (ids, webhooks, display names)

import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://discord.com/api/v10";
// Discord error codes this script reacts to.
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_WEBHOOK = 10015;
const MISSING_PERMISSIONS = 50013;
// The Discord message types a person writes: a plain message and a reply.
const DEFAULT_MESSAGE = 0;
const REPLY_MESSAGE = 19;
// The prefix of every webhook this environment makes, so a reset finds its own.
const WEBHOOK_PREFIX = "cos-";

function die(message) {
  process.stderr.write(`cos-env: ${message}\n`);
  process.exit(1);
}

function state() {
  try {
    return JSON.parse(readFileSync(process.env.COS_STATE, "utf8"));
  } catch {
    die("the environment is not up. Run environments/chief-of-staff/env.sh up first.");
  }
}

function saveState(s) {
  writeFileSync(process.env.COS_STATE, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  // The mode above applies only to a new file, and the state holds webhook tokens.
  chmodSync(process.env.COS_STATE, 0o600);
}

// Calls the Discord API. A null token calls without one, as a webhook URL needs.
async function discord(token, method, path, body) {
  for (;;) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bot ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429) {
      const wait = Number((await response.json()).retry_after ?? 1);
      if (wait > 5)
        process.stderr.write(
          `cos-env: Discord rate-limits ${method} ${path.split("?")[0].replace(/^(\/webhooks\/\d+)\/[^/]+/, "$1/<token>")}, waiting ${Math.ceil(wait)}s\n`,
        );
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000)));
      continue;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const shown = path.replace(/^\/webhooks\/(\d+)\/[^/?]+/, "/webhooks/$1/<token>");
      const error = new Error(
        `Discord answered ${response.status} to ${method} ${shown}: ${data?.message ?? text}`,
      );
      error.code = data?.code;
      throw error;
    }
    return data;
  }
}

function token(name) {
  const value = process.env[name];
  if (!value) die(`${name} is not set`);
  return value;
}

function chatByName(s, name) {
  const id = s.chats[name];
  if (!id) die(`no test chat named "${name}". Test chats: ${Object.keys(s.chats).join(", ")}`);
  return id;
}

function chatNameById(s, id) {
  return Object.entries(s.chats).find(([, chatId]) => chatId === id)?.[0];
}

function webhookOf(s, chat, member) {
  const hook = s.webhooks?.[chat]?.[member];
  if (!hook) {
    const members = Object.keys(s.webhooks?.[chat] ?? {});
    die(
      members.length === 0
        ? `#${chat} has no member webhooks yet. Run cos-env seed <dir> first.`
        : `${member} is not in #${chat}. Members there: ${members.join(", ")}`,
    );
  }
  return hook;
}

// Names each author the way the verifier knows them: a member, "agent",
// "driver", or the Discord username for anyone else. Every webhook of a member,
// its second account's included, reads as the member, since it is one person.
function authorName(s, user) {
  if (user.id === s.agent.id) return "agent";
  if (user.id === s.driver?.id) return "driver";
  for (const hooks of Object.values(s.webhooks ?? {})) {
    for (const [member, hook] of Object.entries(hooks)) {
      if (hook.id === user.id) return member.split(":")[0];
    }
  }
  return user.username;
}

function readable(s, message, thread) {
  return {
    id: message.id,
    author: authorName(s, message.author),
    authorId: message.author.id,
    text: message.content,
    thread: thread ?? null,
    time: message.timestamp,
    replyTo: message.message_reference?.message_id ?? null,
    reactions: (message.reactions ?? []).map((r) => ({
      emoji: r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name,
      count: r.count,
    })),
  };
}

// Every message in a channel after `since`, oldest first. `since` is a Discord
// message id, which orders by time across every channel, so it filters a thread
// by the same cut as its parent.
async function messagesAfter(bot, channelId, since) {
  const all = [];
  let after = since || "0";
  for (;;) {
    const page = await discord(
      bot,
      "GET",
      `/channels/${channelId}/messages?limit=100&after=${after}`,
    );
    if (page.length === 0) break;
    page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    all.push(...page);
    after = all.at(-1).id;
    if (page.length < 100) break;
  }
  // Discord's own notices, such as a member joining the server, are not chat.
  return all.filter((m) => m.type === DEFAULT_MESSAGE || m.type === REPLY_MESSAGE);
}

// The ids of every thread under `channelId`, open or archived, public or private.
async function threadsOf(bot, server, channelId) {
  const active = await discord(bot, "GET", `/guilds/${server}/threads/active`);
  const archived = [];
  for (const kind of ["public", "private"]) {
    try {
      const page = await discord(
        bot,
        "GET",
        `/channels/${channelId}/threads/archived/${kind}?limit=100`,
      );
      archived.push(...page.threads);
    } catch {
      // A chat that cannot hold that kind of thread lists none.
    }
  }
  return [...active.threads, ...archived]
    .filter((thread) => thread.parent_id === channelId)
    .map((thread) => thread.id);
}

// The thread off a message, started from the message when it does not exist
// yet. Answers the thread id and the name of the chat it sits in.
async function threadFor(s, bot, thread, chat) {
  try {
    const existing = await discord(bot, "GET", `/channels/${thread}`);
    const parent = chatNameById(s, existing.parent_id);
    if (!parent) die(`thread ${thread} is not in a test chat`);
    return { id: existing.id, chat: parent };
  } catch (error) {
    if (error.code !== UNKNOWN_CHANNEL) throw error;
  }
  if (!chat)
    die("the thread does not exist yet. Pass --chat so it can be started from the message.");
  const started = await discord(
    bot,
    "POST",
    `/channels/${chatByName(s, chat)}/messages/${thread}/threads`,
    { name: "thread" },
  );
  return { id: started.id, chat };
}

// Deletes every webhook this environment made in the chats.
async function deleteWebhooks(bot, driverId, chatIds) {
  for (const chatId of chatIds) {
    for (const hook of await discord(bot, "GET", `/channels/${chatId}/webhooks`)) {
      if (hook.name?.startsWith(WEBHOOK_PREFIX) && hook.user?.id === driverId) {
        await discord(bot, "DELETE", `/webhooks/${hook.id}`);
      }
    }
  }
}

// Deletes every message in a channel, in bulk where the driver may, else each
// as its author. `parent` is the chat a thread sits in, null for a chat.
// Answers how many messages nobody here may delete.
async function deleteMessages(s, bot, channelId, parent) {
  const twoWeeksAgo = Date.now() - 13.5 * 24 * 3600 * 1000;
  const skipped = new Set();
  let bulk = true;
  for (;;) {
    const page = (await discord(bot, "GET", `/channels/${channelId}/messages?limit=100`)).filter(
      (m) => !skipped.has(m.id),
    );
    if (page.length === 0) break;
    // Bulk delete takes 2 to 100 messages younger than two weeks.
    const recent = page.filter((m) => Date.parse(m.timestamp) > twoWeeksAgo).map((m) => m.id);
    if (bulk && recent.length >= 2) {
      try {
        await discord(bot, "POST", `/channels/${channelId}/messages/bulk-delete`, {
          messages: recent,
        });
        continue;
      } catch (error) {
        if (error.code !== MISSING_PERMISSIONS) throw error;
        bulk = false;
      }
    }
    for (const message of page) {
      if (!(await deleteAsAuthor(s, bot, channelId, parent, message))) skipped.add(message.id);
    }
  }
  return skipped.size;
}

// Deletes one message as the driver, or as its author when the driver may not.
// Answers false when nobody here may delete it.
async function deleteAsAuthor(s, bot, channelId, parent, message) {
  const path = `/channels/${channelId}/messages/${message.id}`;
  const attempts = [() => discord(bot, "DELETE", path)];
  if (message.author.id === s.agent.id && process.env.COS_AGENT_TOKEN) {
    attempts.push(() => discord(process.env.COS_AGENT_TOKEN, "DELETE", path));
  }
  const hook = Object.values(s.webhooks ?? {})
    .flatMap((hooks) => Object.values(hooks))
    .find((h) => h.id === message.webhook_id);
  if (hook) {
    const thread = parent ? `?thread_id=${channelId}` : "";
    attempts.push(() =>
      discord(null, "DELETE", `/webhooks/${hook.id}/${hook.token}/messages/${message.id}${thread}`),
    );
  }
  for (const attempt of attempts) {
    try {
      await attempt();
      return true;
    } catch (error) {
      if (error.code !== MISSING_PERMISSIONS && error.code !== UNKNOWN_WEBHOOK) throw error;
    }
  }
  return false;
}

const commands = {
  // Prints the bot's user id and username, which also checks the token.
  async whoami() {
    const me = await discord(token("COS_TOKEN"), "GET", "/users/@me");
    process.stdout.write(`${JSON.stringify({ id: me.id, username: me.username })}\n`);
  },

  // Prints {name: id} for the named text chats in the test server.
  async chats(...names) {
    const server = token("COS_DISCORD_SERVER_ID");
    const all = await discord(token("COS_TOKEN"), "GET", `/guilds/${server}/channels`);
    const found = {};
    for (const name of names) {
      const chat = all.find((c) => c.name === name && c.type === 0);
      if (!chat) die(`the test server has no text chat named "${name}"`);
      found[name] = chat.id;
    }
    process.stdout.write(`${JSON.stringify(found)}\n`);
  },

  // Gives each member its webhook in each chat. The plan on stdin is
  // {chat: [member, ...]}. A webhook an earlier seed made is kept, since Discord
  // rate-limits making them, and one no member needs now is deleted. The
  // webhooks go into the state file, which holds their tokens.
  async webhooks() {
    const s = state();
    const bot = token("COS_TOKEN");
    const plan = JSON.parse(readFileSync(0, "utf8"));
    s.webhooks = {};
    for (const [chat, members] of Object.entries(plan)) {
      const chatId = chatByName(s, chat);
      const ours = (await discord(bot, "GET", `/channels/${chatId}/webhooks`)).filter(
        (hook) => hook.name?.startsWith(WEBHOOK_PREFIX) && hook.user?.id === s.driver.id,
      );
      s.webhooks[chat] = {};
      for (const member of members) {
        const name = `${WEBHOOK_PREFIX}${member.replace(":", "-")}`;
        const hook =
          ours.find((h) => h.name === name && h.token) ??
          (await discord(bot, "POST", `/channels/${chatId}/webhooks`, { name }));
        s.webhooks[chat][member] = { id: hook.id, token: hook.token };
      }
      const kept = new Set(Object.values(s.webhooks[chat]).map((h) => h.id));
      for (const hook of ours.filter((h) => !kept.has(h.id))) {
        await discord(bot, "DELETE", `/webhooks/${hook.id}`);
      }
    }
    saveState(s);
  },

  // Deletes the members' webhooks in every test chat.
  async "delete-webhooks"() {
    const s = state();
    await deleteWebhooks(token("COS_TOKEN"), s.driver.id, Object.values(s.chats));
    s.webhooks = {};
    saveState(s);
  },

  // Posts as a member through its webhook in the chat. With a thread message
  // id, posts in the thread off that message, starting it when needed.
  async post(member, chat, thread, mentionAgent, text) {
    const s = state();
    const bot = token("COS_TOKEN");
    let threadId = "";
    let chatName = chat;
    if (thread) {
      const found = await threadFor(s, bot, thread, chat);
      threadId = found.id;
      chatName = found.chat;
    } else {
      chatByName(s, chat);
    }
    const hook = webhookOf(s, chatName, member);
    const mention = mentionAgent === "1";
    const sent = await discord(
      null,
      "POST",
      `/webhooks/${hook.id}/${hook.token}?wait=true${threadId ? `&thread_id=${threadId}` : ""}`,
      {
        content: mention ? `<@${s.agent.id}> ${text}` : text,
        username: s.members?.[member]?.name ?? member,
        allowed_mentions: mention ? { parse: [], users: [s.agent.id] } : { parse: [] },
      },
    );
    process.stdout.write(`${sent.id}\n`);
  },

  // Prints messages oldest first as JSON. Without a thread, every message in the
  // chat and in its threads, each tagged with its thread id or null. With a
  // thread, just that thread.
  async read(chat, thread, since) {
    const s = state();
    const bot = token("COS_TOKEN");
    const server = token("COS_DISCORD_SERVER_ID");
    const tagged = [];
    if (thread) {
      for (const m of await messagesAfter(bot, thread, since)) {
        tagged.push(readable(s, m, thread));
      }
    } else {
      const id = chatByName(s, chat);
      for (const m of await messagesAfter(bot, id, since)) tagged.push(readable(s, m, null));
      for (const threadId of await threadsOf(bot, server, id)) {
        for (const m of await messagesAfter(bot, threadId, since)) {
          tagged.push(readable(s, m, threadId));
        }
      }
    }
    tagged.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    process.stdout.write(`${JSON.stringify(tagged, null, 2)}\n`);
  },

  // Sets the display name a member's later messages carry. Messages already
  // sent keep the name they were sent with, as on Discord.
  async rename(member, name) {
    const s = state();
    s.members ??= {};
    s.members[member] = { ...s.members[member], name };
    saveState(s);
  },

  // Deletes every thread under the chat and every message in it. Without
  // Manage Messages and Manage Threads, each message is deleted by whoever
  // wrote it (the agent's bot, the driver, or a member's webhook), and what
  // nobody here can delete is left with a warning rather than failing.
  async clear(id) {
    const s = state();
    const bot = token("COS_TOKEN");
    const server = token("COS_DISCORD_SERVER_ID");
    const left = { messages: 0, threads: 0 };
    for (const threadId of await threadsOf(bot, server, id)) {
      try {
        await discord(bot, "DELETE", `/channels/${threadId}`);
      } catch (error) {
        if (error.code !== MISSING_PERMISSIONS) throw error;
        left.messages += await deleteMessages(s, bot, threadId, id);
        left.threads += 1;
      }
    }
    left.messages += await deleteMessages(s, bot, id, null);
    if (left.messages || left.threads) {
      process.stderr.write(
        `cos-env: left ${left.messages} messages and ${left.threads} threads in #${chatNameById(s, id) ?? id} that the driver may not delete. Give it Manage Messages and Manage Threads.\n`,
      );
    }
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) die(`unknown discord command "${command}"`);
commands[command](...args).catch((error) => die(error.message));
