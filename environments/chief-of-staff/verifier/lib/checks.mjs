// Mechanical checks over what `cos-env read` returns.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `chats` until the agent posts after message `since`, and returns that message with
 * its `chat` added, or null once `timeoutMs` passes. `since` is compared across chats, which
 * holds for Discord ids because they grow with time across a whole server.
 */
export async function waitForAgent(env, { chats, since, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = [];
    for (const chat of chats) {
      for (const message of await env.read({ chat, since })) {
        if (message.author === env.agentAuthor) found.push({ ...message, chat });
      }
    }
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
  for (const chat of chats) {
    for (const message of await env.read({ chat, since })) {
      if (message.author === env.agentAuthor) all.push({ ...message, chat });
    }
  }
  return all;
}

const linkPattern = /https?:\/\/\S+/i;

export function hasLink(text) {
  return linkPattern.test(text);
}

/** The tokens from `tokens` that appear in `text`, ignoring case. */
export function tokensIn(text, tokens) {
  const lower = text.toLowerCase();
  return tokens.filter((t) => lower.includes(t.toLowerCase()));
}

export function secondsBetween(fromTime, toTime) {
  return (Date.parse(toTime) - Date.parse(fromTime)) / 1000;
}
