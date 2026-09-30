import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "rome-start-desktop.sh");

// Stand-ins for the desktop programs. Each records "<program> <pid> <args>" and
// stays up: the X server and websockify listen on the port they are given.
const LISTENER = (program: string) => `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RECORD, \`${program} \${process.pid} \${args.join(" ")}\\n\`);
const port = ${program === "Xtigervnc" ? 'args[args.indexOf("-rfbport") + 1]' : 'args[0].split(":")[1]'};
net.createServer().listen(Number(port), "127.0.0.1");
`;
const OPENBOX = `#!/bin/sh
echo "openbox $$ $DISPLAY $*" >>"$FAKE_RECORD"
while :; do sleep 1; done
`;

let dir: string;
let record: string;
let display: number;
let vncPort: number;
let novncPort: number;
const blockers: Server[] = [];

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, "close");
  return port;
}

function started(): { program: string; pid: number; args: string }[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [program, pid, ...args] = line.split(" ");
      return { program: program!, pid: Number(pid), args: args.join(" ") };
    });
}

function run(...extra: string[]) {
  return runWith({}, ...extra);
}

function runWith(env: Record<string, string>, ...extra: string[]) {
  return spawnSync(
    "bash",
    [SCRIPT, "notes", `:${display}`, String(vncPort), String(novncPort), ...extra],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...env, PATH: `${dir}:${process.env.PATH}`, FAKE_RECORD: record },
    },
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rome-start-desktop-"));
  record = join(dir, "record");
  for (const program of ["Xtigervnc", "websockify"]) {
    writeFileSync(join(dir, program), LISTENER(program));
    chmodSync(join(dir, program), 0o755);
  }
  writeFileSync(join(dir, "openbox"), OPENBOX);
  chmodSync(join(dir, "openbox"), 0o755);
  display = 400 + Math.floor(Math.random() * 500);
  while (existsSync(`/tmp/.X${display}-lock`)) display++;
  vncPort = await freePort();
  novncPort = await freePort();
});

afterEach(() => {
  const pids = started().map(({ pid }) => String(pid));
  if (pids.length > 0) spawnSync("kill", ["-9", ...pids]);
  for (const server of blockers.splice(0)) server.close();
  rmSync(`/tmp/.X${display}-lock`, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

// The script and these tests read /proc and use setsid and pgrep, so they need Linux.
describe.skipIf(process.platform !== "linux")("rome-start-desktop.sh", () => {
  it("starts the desktop detached, then reuses it", () => {
    const first = run("/rc.xml");
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const procs = started();
    expect(procs.map((proc) => proc.program)).toEqual(["Xtigervnc", "openbox", "websockify"]);
    expect(procs[0]!.args).toContain(`:${display} -geometry 1280x800 -depth 24`);
    expect(procs[0]!.args).toContain(`-localhost yes -rfbport ${vncPort}`);
    expect(procs[1]!.args).toBe(`:${display} --config-file /rc.xml`);
    expect(procs[2]!.args).toBe(`127.0.0.1:${novncPort} localhost:${vncPort}`);
    for (const { pid } of procs) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const session = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
      expect(session).toBe(pid);
    }

    const second = run("/rc.xml");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`Reusing TigerVNC for notes on :${display}.`);
    expect(started()).toHaveLength(3);
  }, 60_000);

  it("finds a running Openbox whose environment outgrows a pipe buffer", () => {
    // Programs started from the entrypoint inherit its whole environment.
    const big = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`ROME_TEST_PAD_${i}`, "x".repeat(8_000)]),
    );
    expect(runWith(big).status).toBe(0);
    const second = runWith(big);

    expect(second.stderr).toBe("");
    expect(second.status).toBe(0);
    expect(started().filter((proc) => proc.program === "openbox")).toHaveLength(1);
  }, 60_000);

  it("clears a stale X lock whose owner has exited", async () => {
    const exited = spawn("true");
    await once(exited, "exit");
    writeFileSync(`/tmp/.X${display}-lock`, `${exited.pid}\n`);

    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removing stale X lock /tmp/.X${display}-lock.`);
  }, 60_000);

  it("treats an unreaped zombie holding the X lock as dead", async () => {
    // The child exits once the parent has exec'd into sleep, which never reaps
    // it. A child that exits before the exec can be reaped by sh itself.
    const parent = spawn("sh", ["-c", "sleep 0.3 & echo $!; exec sleep 30"]);
    const [line] = (await once(parent.stdout, "data")) as [Buffer];
    const zombie = Number(line.toString().trim());
    try {
      for (
        let i = 0;
        i < 150 && !readFileSync(`/proc/${zombie}/stat`, "utf8").includes(") Z ");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      writeFileSync(`/tmp/.X${display}-lock`, `${zombie}\n`);

      const result = run();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Removing stale X lock /tmp/.X${display}-lock.`);
    } finally {
      parent.kill("SIGKILL");
    }
  }, 60_000);

  it("clears an X lock whose pid now belongs to a program other than an X server", () => {
    // After a container restart the lock's pid can name any new process.
    writeFileSync(`/tmp/.X${display}-lock`, `${process.pid}\n`);

    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removing stale X lock /tmp/.X${display}-lock.`);
  }, 60_000);

  it("refuses a display whose X lock a live X server holds", async () => {
    writeFileSync(join(dir, "Xvfb"), "#!/bin/sh\nwhile :; do sleep 1; done\n");
    chmodSync(join(dir, "Xvfb"), 0o755);
    const foreign = spawn(join(dir, "Xvfb"));
    await once(foreign, "spawn");
    try {
      writeFileSync(`/tmp/.X${display}-lock`, `${foreign.pid}\n`);

      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `the existing X server on :${display} is not Rome's TigerVNC process`,
      );
      expect(started()).toEqual([]);
    } finally {
      foreign.kill("SIGKILL");
    }
  });

  it("refuses an RFB port another process holds", async () => {
    const blocker = createServer().listen(vncPort, "127.0.0.1");
    blockers.push(blocker);
    await once(blocker, "listening");

    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`TCP port ${vncPort} is already in use by another process`);
    expect(started()).toEqual([]);
  });

  it("rejects malformed arguments", () => {
    const result = spawnSync("bash", [SCRIPT, "notes", "100", "5901", "6081"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
  });
});
