// Rome Cloud's read-only query command from env.json (`rome_cloud.query`):
// an argv array that takes SQL on stdin and prints rows as a JSON array.

import { spawn } from "node:child_process";

/** Runs `sql` through the query command `argv`. Rejects on a non-zero exit. */
export function query(argv, sql, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error(`query exited ${code}: ${err.trim().slice(-300)}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`query printed no JSON: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.end(sql);
  });
}
