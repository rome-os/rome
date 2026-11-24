// The stand-in instance's controls, shaped as the environment's ctl.sh:
// node ctl.mjs <state dir> stop|start|status|logs [--since <time>].
// status prints {"instance", "state": running|stopped}.

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, action, ...rest] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(dir, "instance.json"), "utf8"));
const pidFile = join(dir, "instance.pid");
const logFile = join(dir, "instance.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    return (
      await fetch(`http://127.0.0.1:${config.env.PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
}

async function until(want) {
  for (let i = 0; i < 100; i++) {
    if ((await healthy()) === want) return true;
    await sleep(100);
  }
  return false;
}

if (action === "start") {
  if (!(await healthy())) {
    const out = openSync(logFile, "a");
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("instance.mjs", import.meta.url))],
      {
        env: { ...process.env, ...config.env },
        stdio: ["ignore", out, out],
        detached: true,
      },
    );
    child.unref();
    writeFileSync(pidFile, String(child.pid));
  }
  process.exit((await until(true)) ? 0 : 1);
} else if (action === "stop") {
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    } catch {}
    rmSync(pidFile, { force: true });
  }
  process.exit((await until(false)) ? 0 : 1);
} else if (action === "status") {
  process.stdout.write(
    `${JSON.stringify({ instance: "standin", state: (await healthy()) ? "running" : "stopped" })}\n`,
  );
} else if (action === "logs") {
  const i = rest.indexOf("--since");
  const since = i >= 0 ? Date.parse(rest[i + 1]) : 0;
  const lines = existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean)
    : [];
  for (const line of lines) {
    let at = 0;
    try {
      at = Date.parse(JSON.parse(line).timestamp);
    } catch {}
    if (!since || at >= since) process.stdout.write(`${line}\n`);
  }
} else {
  process.stderr.write("usage: ctl.mjs <dir> stop|start|status|logs\n");
  process.exit(2);
}
