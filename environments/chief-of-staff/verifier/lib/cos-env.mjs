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
    /** Messages oldest first, each `{ id, author, text, thread, time, reactions }`. */
    async read({ chat, thread, since }) {
      const args = ["read", "--chat", chat];
      if (thread) args.push("--thread", thread);
      if (since) args.push("--since", since);
      const out = await call(args);
      return out ? JSON.parse(out) : [];
    },
    async rome(action) {
      await call(["rome", action]);
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

/** The chat name `read` takes for a member's direct messages with the agent. */
export function dmChat(account) {
  return `dm:${account}`;
}
