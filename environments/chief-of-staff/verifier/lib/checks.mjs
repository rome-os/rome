// Mechanical checks over what `cos-env read` returns.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A chat entry is a shared chat's name, or `{ dm, label }` for a stand-in direct message.
const readArgs = (chat) => (typeof chat === "string" ? { chat } : { dm: chat.dm });
const label = (chat) => (typeof chat === "string" ? chat : chat.label);

async function agentMessagesIn(env, chat, since) {
  const found = [];
  for (const message of await env.read({ ...readArgs(chat), since })) {
    if (message.author === env.agentAuthor) found.push({ ...message, chat: label(chat) });
  }
  return found;
}

/**
 * Polls `chats` until the agent posts after message `since`, and returns that message with
 * its `chat` added, or null once `timeoutMs` passes. `since` is compared across chats, which
 * holds for Discord ids because they grow with time across a whole server.
 */
export async function waitForAgent(env, { chats, since, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = [];
    for (const chat of chats) found.push(...(await agentMessagesIn(env, chat, since)));
    if (found.length > 0) {
      found.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      return found[0];
    }
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/** Every message the agent posted in `chats` after `since`, each with its `chat` added. */
export async function agentMessagesSince(env, { chats, since }) {
  const all = [];
  for (const chat of chats) all.push(...(await agentMessagesIn(env, chat, since)));
  return all;
}

const linkPattern = /https?:\/\/\S+/i;

export function hasLink(text) {
  return linkPattern.test(text);
}

const SOURCE_CLAUSE =
  /\bsources?\b[^:\n]*:\s*([^\n]+)|\bsources?\s+(?:for [^\n]*? )?is\s+([^\n]+)/gi;
const DOCUMENT = /roster|goals?\s+doc/i;
const QUOTED = /["'“‘][^"'”’]{3,}["'”’]/;

/**
 * Whether `text` gives its source the way rule K5 (R3) asks: a link (to a message, or to a
 * document the reader can open), or a source clause that names a document and an entry in it.
 * An entry is a member's name, a goal's title or id, or any quoted entry name.
 */
export function namesSource(text, team) {
  if (hasLink(text)) return true;
  const entries = [
    ...team.members.map((m) => m.name),
    ...team.goals.flatMap((g) => [g.title, g.id]),
  ].map((e) => e.toLowerCase());
  return [...text.matchAll(SOURCE_CLAUSE)]
    .map((m) => m[1] ?? m[2])
    .some((clause) => {
      const lower = clause.toLowerCase();
      return (
        DOCUMENT.test(clause) &&
        (QUOTED.test(clause) || entries.some((e) => new RegExp(`\\b${e}\\b`).test(lower)))
      );
    });
}

const MARKED_DROPPED =
  /\bdropped\b|no longer|cancel+ed|left (?:it )?out|not (?:a )?current|retired|abandoned/i;

/**
 * The tokens from `tokens` that `text` presents as current: each line naming one counts
 * unless that line also marks it as dropped, such as "lists X as dropped, so I left it out".
 */
export function presentedAsCurrent(text, tokens) {
  return text
    .split("\n")
    .filter((line) => !MARKED_DROPPED.test(line))
    .flatMap((line) => tokensIn(line, tokens));
}

/** The tokens from `tokens` that appear in `text`, ignoring case. */
export function tokensIn(text, tokens) {
  const lower = text.toLowerCase();
  return tokens.filter((t) => lower.includes(t.toLowerCase()));
}

export function secondsBetween(fromTime, toTime) {
  return (Date.parse(toTime) - Date.parse(fromTime)) / 1000;
}
