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
    /** Posts as a member and returns the new message's id. */
    async post({ as, chat, thread, mentionAgent = false, text }) {
      const args = ["post", "--as", as, "--chat", chat];
      if (thread) args.push("--thread", thread);
      if (mentionAgent) args.push("--mention-agent");
      args.push(text);
      return call(args);
    },
    /** Sends the agent a direct message as a member and returns its id. */
    async dm({ as, text }) {
      return call(["dm", "--as", as, text]);
    },
    /**
     * Messages oldest first, each `{ id, author, text, thread, time, reactions }`. Pass
     * `{ chat }` for a shared chat or `{ dm: member }` for the private chat that stands in
     * for a direct message (`cos-env read --dm <member>`).
     */
    async read({ chat, dm, thread, since }) {
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
    async rename({ as, displayName }) {
      await call(["rename", "--as", as, displayName]);
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
