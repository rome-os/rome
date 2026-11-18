// Client for the `cos-env` command, the only way the verifier touches the environment.
// Contract: environments/chief-of-staff/README.md. What the verifier assumes beyond it is
// listed under "Contract gaps" in this folder's README.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * `command` is the cos-env executable followed by any fixed arguments, such as
 * `["node", "fake/cos-env.mjs"]`. `agentAuthor` is the `author` value `read` gives the
 * agent's messages.
 */
export function cosEnv({ command, agentAuthor = "agent", env = process.env }) {
  const [bin, ...fixed] = command;
  const call = async (args) => {
    try {
      const { stdout } = await run(bin, [...fixed, ...args], { env, maxBuffer: 64 * 1024 * 1024 });
      return stdout.trim();
    } catch (error) {
      const detail = error.stderr?.toString().trim() || error.message;
      throw new Error(`cos-env ${args[0]} failed: ${detail}`);
    }
  };

  return {
    agentAuthor,
    /**
     * Posts as a member, or as the driver bot itself with `as: "driver"`, and returns the new
     * message's id. `mentionSecond` mentions the environment's second Rome bot.
     */
    async post({ as, chat, thread, mentionAgent = false, mentionSecond = false, text }) {
      const args = ["post", "--as", as, "--chat", chat];
      if (thread) args.push("--thread", thread);
      if (mentionAgent) args.push("--mention-agent");
      if (mentionSecond) args.push("--mention-second");
      args.push(text);
      return call(args);
    },
    /**
     * Sends the agent a direct message as a member and returns its id. Rome sees the private
     * chat standing in for a direct message as a group chat, so a message there pings the agent
     * only with `mentionAgent`, which posts it in that chat with a mention.
     */
    async dm({ as, text, mentionAgent = false }) {
      if (mentionAgent)
        return call([
          "post",
          "--as",
          as,
          "--chat",
          `dm-${as.split(":")[0]}`,
          "--mention-agent",
          text,
        ]);
      return call(["dm", "--as", as, text]);
    },
    /**
     * Messages oldest first, each `{ id, author, text, thread, time, reactions }`. Pass
     * `{ chat }` for a shared chat or `{ dm: member }` for the private chat that stands in
     * for a direct message (`cos-env read --dm <member>`).
     */
    async read({ chat, dm, thread, since }) {
      // Without a chat, cos-env prints only its usage; name the bad call instead.
      if (!chat && !dm)
        throw new Error(
          `read needs a chat or a member: ${JSON.stringify({ chat, dm, thread, since })}`,
        );
      const args = dm ? ["read", "--dm", dm] : ["read", "--chat", chat];
      if (thread) args.push("--thread", thread);
      if (since) args.push("--since", since);
      const out = await call(args);
      return out ? JSON.parse(out) : [];
    },
    async rome(action) {
      await call(["rome", action]);
    },
    /** Renews the agent's session in `chat`, as `cos-env rome renew-session --chat <name>`. */
    async renewSession(chat) {
      await call(["rome", "renew-session", "--chat", chat]);
    },
    /**
     * The replies the envoy held back since `since` (an ISO time), as `cos-env rome held`
     * prints them: JSON when it can be parsed, else the raw text. Throws when the
     * environment has no such command.
     */
    async held(since) {
      const out = await call(["rome", "held", "--since", since]);
      try {
        return JSON.parse(out);
      } catch {
        return out;
      }
    },
    /** Moves the agent's clock `hours` ahead of any earlier move; Rome restarts under the new time. */
    async clockForward(hours) {
      await call(["clock", "forward", String(hours)]);
    },
    /**
     * The agent's turns since `since` (an ISO time), one per line as `cos-env usage` prints
     * them: `{ start, turnId, sessionId, session, inputTokens, outputTokens, cacheReadTokens,
     * cacheWriteTokens, costUsd }`. Throws when the environment has no such command.
     */
    async usage(since) {
      const out = await call(["usage", "--since", since]);
      return out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    },
    /**
     * Each model call since `since`, one per line as `cos-env usage --per-call` prints them:
     * `{ time, turnId, session, claudeSession, requestId, model, inputTokens, cacheReadTokens,
     * cacheWriteTokens, outputTokens }`. Throws when the environment has no such command.
     */
    async usagePerCall(since) {
      const out = await call(["usage", "--per-call", "--since", since]);
      return out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    },
    /**
     * What the agent did with its memory folder since `since`, as `cos-env memory` prints it:
     * `{ files: [{ path, bytes, modified }], toolUses: [{ time, tool, path }] }`. An
     * observation only, never evidence. Throws when the environment has no such command.
     */
    async memory(since) {
      return JSON.parse(await call(["memory", "--since", since]));
    },
    /** Every memory.md the app renders, as `[{ place, text }]`, one per place. */
    async memoryFiles() {
      const out = await call(["memory"]);
      return out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    },
    /**
     * Arms a test-only crash: the app's worker exits when its next turn reaches `point`,
     * `before-commit`, `after-commit-before-send` or `mid-outbox`. Rome stays up and needs
     * `rome restart` to start the worker again.
     */
    async crashAt(point) {
      return JSON.parse(await call(["crash-at", point]));
    },
    /** The app's committed turns per event and its outbox counts, `{ events, outbox }`. */
    async handled() {
      return JSON.parse(await call(["handled"]));
    },
    /** A document the app holds for the agent (`goals` or `roster`), as its current text. */
    async doc(name) {
      return call(["doc", name]);
    },
    /**
     * Resets one of the agent's chats to Rome's defaults, then applies `setting`: `default`,
     * `mentions-only`, `ignore-others`, `off` or `every`.
     */
    async chatSetting(chat, setting) {
      await call(["chat", chat, setting]);
    },
    /** Takes the agent off its connected account. */
    async unlink() {
      await call(["unlink"]);
    },
    /** Links the agent to its connected account again. */
    async link() {
      await call(["link"]);
    },
    async rename({ as, displayName }) {
      await call(["rename", "--as", as, displayName]);
    },
    /** Copies Rome's logs since `since` (an ISO time), with memory stats, into `dir`. */
    async logs(dir, since) {
      await call(["logs", dir, "--since", since]);
    },
    async reset() {
      await call(["reset"]);
    },
    async seed(dir) {
      await call(["seed", dir]);
    },
    /** The commits under test, dirty flags and model, as `cos-env version` prints them. */
    async version() {
      return JSON.parse(await call(["version"]));
    },
  };
}

/**
 * The private chat that stands in for a member's direct messages with the agent, as a chat
 * entry the check helpers and `read` understand. Bots cannot send each other direct
 * messages, so the scripted run uses a chat only the agent and that member can read.
 */
export function dmChat(member) {
  return { dm: member, label: `dm-${member}` };
}
