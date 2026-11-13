#!/usr/bin/env node
// The Discord side of the chief of staff environment: everything the member
// bots do, over the Discord REST API with no dependency to install. cos-env and
// env.sh call it. Bot tokens arrive in the environment, never in argv, since
// argv shows in `ps`.
//
//   COS_TOKEN               the token of the bot acting
//   COS_READER_TOKEN        the token used to read and clear chats
//   COS_DISCORD_SERVER_ID   the test server
//   COS_STATE               the state file env.sh writes (ids of bots and chats)

import { readFileSync } from "node:fs";

const API = "https://discord.com/api/v10";

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

async function discord(token, method, path, body) {
  for (;;) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
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
      const error = new Error(
        `Discord answered ${response.status} to ${method} ${path}: ${data?.message ?? text}`,
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

function chatId(s, name, thread) {
  if (thread) return thread;
  const id = s.chats[name];
  if (!id) die(`no test chat named "${name}". Test chats: ${Object.keys(s.chats).join(", ")}`);
  return id;
}

// Names each author the way the verifier knows them: a member's name, "agent",
// or the Discord username for anyone else.
function authorName(s, user) {
  if (user.id === s.agent.id) return "agent";
  const member = Object.entries(s.members).find(([, m]) => m.id === user.id);
  return member ? member[0] : user.username;
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

  async post(chat, thread, mentionAgent, text) {
    const s = state();
    const content = mentionAgent === "1" ? `<@${s.agent.id}> ${text}` : text;
    const sent = await discord(
      token("COS_TOKEN"),
      "POST",
      `/channels/${chatId(s, chat, thread)}/messages`,
      {
        content,
        allowed_mentions: { parse: ["users"] },
      },
    );
    process.stdout.write(`${sent.id}\n`);
  },

  async dm(text) {
    const s = state();
    const bot = token("COS_TOKEN");
    let dmChat;
    try {
      dmChat = await discord(bot, "POST", "/users/@me/channels", { recipient_id: s.agent.id });
      const sent = await discord(bot, "POST", `/channels/${dmChat.id}/messages`, { content: text });
      process.stdout.write(`${sent.id}\n`);
    } catch (error) {
      // 50007: Discord refuses a direct message between two bots.
      if (error.code === 50007) {
        die(
          "Discord does not let one bot send a direct message to another, so a member bot cannot DM the agent. See the README.",
        );
      }
      throw error;
    }
  },

  // Prints messages oldest first as JSON, every message in the chat or thread
  // after `since` when it is given.
  async read(chat, thread, since) {
    const s = state();
    const reader = token("COS_READER_TOKEN");
    const id = chatId(s, chat, thread);
    const messages = [];
    let after = since || "0";
    for (;;) {
      const page = await discord(
        reader,
        "GET",
        `/channels/${id}/messages?limit=100&after=${after}`,
      );
      if (page.length === 0) break;
      page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      messages.push(...page);
      after = page.at(-1).id;
      if (page.length < 100) break;
    }
    process.stdout.write(
      `${JSON.stringify(
        messages.map((m) => readable(s, m, thread || null)),
        null,
        2,
      )}\n`,
    );
  },

  // Sets the acting bot's display name in the test server. An empty name goes
  // back to the bot's username.
  async rename(name) {
    const server = token("COS_DISCORD_SERVER_ID");
    await discord(token("COS_TOKEN"), "PATCH", `/guilds/${server}/members/@me`, {
      nick: name || null,
    });
  },

  // Deletes every thread under the chat and every message in it.
  async clear(id) {
    const reader = token("COS_READER_TOKEN");
    const server = token("COS_DISCORD_SERVER_ID");
    const active = await discord(reader, "GET", `/guilds/${server}/threads/active`);
    const archived = await discord(
      reader,
      "GET",
      `/channels/${id}/threads/archived/public?limit=100`,
    );
    for (const thread of [...active.threads, ...archived.threads]) {
      if (thread.parent_id === id) await discord(reader, "DELETE", `/channels/${thread.id}`);
    }
    const twoWeeksAgo = Date.now() - 13.5 * 24 * 3600 * 1000;
    for (;;) {
      const page = await discord(reader, "GET", `/channels/${id}/messages?limit=100`);
      if (page.length === 0) break;
      // Bulk delete takes 2 to 100 messages younger than two weeks. Older ones,
      // and a lone message, go one at a time.
      const recent = page.filter((m) => Date.parse(m.timestamp) > twoWeeksAgo).map((m) => m.id);
      const old = page.filter((m) => !recent.includes(m.id)).map((m) => m.id);
      if (recent.length >= 2) {
        await discord(reader, "POST", `/channels/${id}/messages/bulk-delete`, { messages: recent });
      } else {
        old.push(...recent);
      }
      for (const message of old)
        await discord(reader, "DELETE", `/channels/${id}/messages/${message}`);
    }
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) die(`unknown discord command "${command}"`);
commands[command](...args).catch((error) => die(error.message));
