// Runs an environment control: an argv array from env.json, with arguments
// appended.

import { spawn } from "node:child_process";

/** Runs `argv` plus `args`. Resolves {code, stdout, stderr, ms}; never rejects on a non-zero exit. */
export function run(argv, args = [], { timeoutMs = 600_000, cwd, env } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0], [...argv.slice(1), ...args], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, ms: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? (signal ? -1 : 0),
        stdout,
        stderr,
        ms: Date.now() - started,
        signal,
      });
    });
  });
}

/** The last JSON object a control printed, or null. */
export function lastJson(text) {
  const lines = text.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return null;
}
