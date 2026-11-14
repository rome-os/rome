#!/usr/bin/env node
// A fake `voice-env` over the stand-in product, for the verifier's own tests. It prints what
// environments/voice-input/voice-env prints. VOICE_FAKE_STATE names the state file and
// VOICE_FAKE_URL the stand-in's address. `reset` stands in for `env.sh reset`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { emptyState, readState, updateState } from "./state.mjs";

const statePath = process.env.VOICE_FAKE_STATE;
const baseUrl = process.env.VOICE_FAKE_URL;
if (!statePath || !baseUrl) {
  console.error("VOICE_FAKE_STATE and VOICE_FAKE_URL must be set");
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    mic: { type: "string" },
    permission: { type: "string", default: "granted" },
    lang: { type: "string", default: "en" },
    text: { type: "string" },
    error: { type: "string" },
    chat: { type: "string" },
  },
});
const print = (value) => console.log(JSON.stringify(value));

/** Chromium from PATH, as the devShell provides it. */
function chromiumOnPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (existsSync(join(dir, "chromium"))) return join(dir, "chromium");
  }
  throw new Error("no chromium on PATH; run inside nix develop");
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Where systemd is there, each Chrome's memory is capped, as the environment caps its own.
const SYSTEMD_RUN = "/run/current-system/sw/bin/systemd-run";

/** Whether a user scope can start here; a stripped test environment has no user manager. */
function systemdWorks() {
  if (!existsSync(SYSTEMD_RUN)) return false;
  try {
    execFileSync(SYSTEMD_RUN, ["--user", "--scope", "--quiet", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Stops the Chrome this fake started, every process on its profile, and removes the profile. */
function stopBrowser() {
  const { browserPid, browserProfile } = readState(statePath);
  if (browserPid) {
    try {
      process.kill(-browserPid, "SIGKILL");
    } catch {}
  }
  if (browserProfile) {
    try {
      execFileSync("pkill", ["-KILL", "-f", "--", `--user-data-dir=${browserProfile}`]);
    } catch {}
    rmSync(browserProfile, { recursive: true, force: true });
  }
  updateState(statePath, (s) => {
    s.browserPid = null;
    s.browserProfile = null;
  });
}

async function startBrowser() {
  stopBrowser();
  const port = await freePort();
  // Profiles live beside the state file, so a test's folder holds everything it made.
  const profile = mkdtempSync(join(dirname(statePath), "chrome-"));
  const chromium = chromiumOnPath();
  const capped = systemdWorks()
    ? [SYSTEMD_RUN, "--user", "--scope", "--quiet", "-p", "MemoryMax=2G", "--", chromium]
    : [chromium];
  const child = spawn(
    capped[0],
    [
      ...capped.slice(1),
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      ...(values.mic ? [`--use-file-for-fake-audio-capture=${values.mic}%noloop`] : []),
      `--lang=${values.lang}`,
      `${baseUrl}/`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  updateState(statePath, (s) => {
    s.mic = values.mic;
    s.browserPid = child.pid;
    s.browserProfile = profile;
  });
  const cdp = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    const ready = await fetch(`${cdp}/json/list`)
      .then((r) => r.json())
      .then((pages) => pages.some((p) => p.url.startsWith(baseUrl)))
      .catch(() => false);
    if (ready) return { cdp };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("chromium did not start");
}

switch (command) {
  case "version": {
    const state = readState(statePath);
    print({
      product: { ref: "fake", commit: `fake-${state.variant}` },
      environment: { commit: "fake" },
      transcriber:
        state.transcriber.mode === "real"
          ? { provider: "soniox", model: "fake" }
          : { provider: "stand-in", script: { text: state.transcriber.text } },
    });
    break;
  }
  case "reset":
    updateState(statePath, (s) => Object.assign(s, emptyState(s.variant)));
    break;
  case "browser":
    if (positionals[0] === "stop") {
      stopBrowser();
      print({ stopped: true });
    } else {
      print(await startBrowser());
    }
    break;
  case "transcriber":
    updateState(statePath, (s) => {
      s.transcriber = {
        mode: positionals[0],
        text: values.text ?? "",
        error: values.error ?? null,
      };
    });
    break;
  case "chats":
    print(Object.keys(readState(statePath).chats).map((id) => ({ id })));
    break;
  case "messages": {
    const messages = readState(statePath).chats[values.chat] ?? [];
    print({ chat: values.chat, count: messages.length, messages });
    break;
  }
  case "network":
    break;
  case "capture":
    if (positionals[0] === "start") {
      updateState(statePath, (s) => {
        s.capturing = true;
        s.captured = [];
      });
      print({ capturing: true });
    } else {
      const { captured } = updateState(statePath, (s) => {
        s.capturing = false;
      });
      print({ audio: captured });
    }
    break;
  case "gate":
    updateState(statePath, (s) => {
      s.cloud.gate = positionals[0] === "on";
    });
    break;
  case "cloud": {
    if (positionals[0] === "session") {
      // fail-11g mints a credential for an account the gate refuses.
      const { cloud, variant } = updateState(statePath, (s) => {
        if (s.cloud.gate || s.variant === "fail-11g") s.cloud.minted++;
      });
      print(
        cloud.gate
          ? { status: 201, body: { sessionId: "s1", provider: "soniox" } }
          : { status: 403, body: { error: "voice_input_not_allowed", variant } },
      );
      break;
    }
    const { cloud } = readState(statePath);
    if (positionals[0] === "usage") print({ events: cloud.usage });
    else if (positionals[0] === "minted") print({ count: cloud.minted });
    else print({ signedIn: cloud.signedIn, ownCredential: cloud.ownCredential });
    break;
  }
  case "audio-scan":
    print({ findings: readState(statePath).audioFiles });
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
