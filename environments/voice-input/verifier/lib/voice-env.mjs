// Client for the `voice-env` command, the only way the verifier touches the environment.
// Contract: environments/voice-input/README.md. What the verifier needs beyond it is listed
// under "Contract with the environment" in this folder's README.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * `command` is the voice-env executable followed by any fixed arguments, such as
 * `["node", "fake/voice-env.mjs"]`. `resetCommand` returns the instance to an empty state;
 * the environment keeps that in `env.sh reset`, outside voice-env. Every method throws when
 * the command fails, with its stderr in the message.
 */
export function voiceEnv({ command, resetCommand, env = process.env }) {
  const exec = async ([bin, ...fixed], args) => {
    try {
      const { stdout } = await run(bin, [...fixed, ...args], { env, maxBuffer: 64 * 1024 * 1024 });
      return stdout.trim();
    } catch (error) {
      const detail = error.stderr?.toString().trim() || error.message;
      throw new Error(`${[bin, ...args].join(" ")} failed: ${detail}`);
    }
  };
  const json = async (args) => {
    const out = await exec(command, args);
    return out ? JSON.parse(out) : null;
  };
  const messages = async (chat) => {
    const out = await json(["messages", "--chat", chat]);
    return (Array.isArray(out) ? out : (out?.messages ?? [])).map((m) => ({ ...m, chat }));
  };

  return {
    /** `{ product, environment, transcriber, ... }`; commits carry `commit` and maybe `dirty`. */
    version: () => json(["version"]),
    /**
     * Starts Chrome with `mic` as the microphone, replacing any Chrome it started before.
     * Resolves to `{ cdp }`, whose first page is on the dashboard, signed in as the guardian.
     */
    browser: ({ mic, permission = "granted", language = "en" }) =>
      json(["browser", "--mic", mic, "--permission", permission, "--lang", language]),
    stopBrowser: () => exec(command, ["browser", "stop"]),
    /**
     * Points Rome at the real transcriber, or at the stand-in. The stand-in returns `text`
     * as the transcript of whatever it hears, or the Soniox error `errorCode`.
     */
    transcriber: async ({ mode, text, errorCode }) => {
      const args = ["transcriber", mode];
      if (text !== undefined) args.push("--text", text);
      if (errorCode !== undefined) args.push("--error", String(errorCode));
      await exec(command, args);
    },
    /**
     * `{ signedIn, ownCredential }`: whether the instance is signed in to Rome Cloud, and
     * whether its config holds its own `ROME_TRANSCRIPTION_API_KEY`.
     */
    cloudStatus: () => json(["cloud", "status"]),
    /** `{ events: [{ provider, model, seconds, at }] }`: Rome Cloud's voice usage for the instance, oldest first. */
    cloudUsage: () => json(["cloud", "usage"]),
    reset: () => (resetCommand ? exec(resetCommand, []) : Promise.resolve()),
    /**
     * Every stored message in every chat, each `{ id, chat, role, sender, text, attachments }`.
     * The verifier knows no chat id in advance, so it compares snapshots of this.
     */
    allMessages: async () => {
      const out = await json(["chats"]);
      const chats = Array.isArray(out) ? out : (out?.sessions ?? out?.chats ?? []);
      return (await Promise.all(chats.map((c) => messages(c.id ?? c.sessionId)))).flat();
    },
    network: (action) => exec(command, ["network", action]),
    captureStart: () => exec(command, ["capture", "start"]),
    /** `{ requests: [{ from: "browser" | "server", to, host, evidence }] }`, audio only. */
    captureStop: async () => {
      const out = await json(["capture", "stop"]);
      return {
        requests: (out.audio ?? []).map((a) => ({
          from: a.side,
          to: a.to,
          host: a.host ?? a.address ?? null,
          evidence: a.evidence,
        })),
      };
    },
    /** `{ found: [{ path, reasons }] }`, empty when the instance holds no audio. */
    audioScan: async () => {
      const out = await json(["audio-scan"]);
      return {
        found: (out.findings ?? []).map((f) => ({ path: f.path, reasons: f.reasons ?? [] })),
      };
    },
  };
}

/** New messages in `after` that are not in `before`, oldest first. */
export function newMessages(before, after) {
  const seen = new Set(before.map((m) => `${m.chat}/${m.id}`));
  return after.filter((m) => !seen.has(`${m.chat}/${m.id}`));
}
