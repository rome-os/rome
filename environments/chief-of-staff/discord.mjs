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
  return all;
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

  // Replaces the members' webhooks. The plan on stdin is {chat: [member, ...]};
  // the webhooks go into the state file, which holds their tokens.
  async webhooks() {
    const s = state();
    const bot = token("COS_TOKEN");
    const plan = JSON.parse(readFileSync(0, "utf8"));
    await deleteWebhooks(
      bot,
      s.driver.id,
      Object.keys(plan).map((chat) => chatByName(s, chat)),
    );
    s.webhooks = {};
    for (const [chat, members] of Object.entries(plan)) {
      s.webhooks[chat] = {};
      for (const member of members) {
        const hook = await discord(bot, "POST", `/channels/${chatByName(s, chat)}/webhooks`, {
          name: `${WEBHOOK_PREFIX}${member.replace(":", "-")}`,
        });
        s.webhooks[chat][member] = { id: hook.id, token: hook.token };
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

  // Deletes every thread under the chat and every message in it.
  async clear(id) {
    const bot = token("COS_TOKEN");
    const server = token("COS_DISCORD_SERVER_ID");
    for (const threadId of await threadsOf(bot, server, id)) {
      await discord(bot, "DELETE", `/channels/${threadId}`);
    }
    const twoWeeksAgo = Date.now() - 13.5 * 24 * 3600 * 1000;
    for (;;) {
      const page = await discord(bot, "GET", `/channels/${id}/messages?limit=100`);
      if (page.length === 0) break;
      // Bulk delete takes 2 to 100 messages younger than two weeks. Older ones,
      // and a lone message, go one at a time.
      const recent = page.filter((m) => Date.parse(m.timestamp) > twoWeeksAgo).map((m) => m.id);
      const old = page.filter((m) => !recent.includes(m.id)).map((m) => m.id);
      if (recent.length >= 2) {
        await discord(bot, "POST", `/channels/${id}/messages/bulk-delete`, { messages: recent });
      } else {
        old.push(...recent);
      }
      for (const message of old) {
        await discord(bot, "DELETE", `/channels/${id}/messages/${message}`);
      }
    }
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) die(`unknown discord command "${command}"`);
commands[command](...args).catch((error) => die(error.message));
