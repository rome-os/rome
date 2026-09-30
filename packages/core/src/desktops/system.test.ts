import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { nodeDesktopSystem } from "./system.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rome-desktops-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fakeProcess(pid: number, argv: string[], env: string[], state = "S") {
  const dir = join(root, "proc", String(pid));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cmdline"), `${argv.join("\0")}\0`);
  await writeFile(join(dir, "environ"), `${env.join("\0")}\0`);
  await writeFile(join(dir, "stat"), `${pid} (${argv[0]} (x)) ${state} 1 ${pid} ${pid}\n`);
}

describe("nodeDesktopSystem", () => {
  it("lists the desktop programs, including websockify run by its interpreter", async () => {
    await fakeProcess(10, ["Xtigervnc", ":100", "-rfbport", "5901"], ["ROME_DESKTOP=notes"]);
    await fakeProcess(
      11,
      ["/usr/bin/python3", "/usr/bin/websockify", "127.0.0.1:6081", "localhost:5901"],
      ["A=b=c"],
    );
    await fakeProcess(12, ["/usr/bin/node", "rome.js"], []);
    await mkdir(join(root, "proc", "self"), { recursive: true });

    const system = nodeDesktopSystem({ procDir: join(root, "proc") });
    const procs = await system.processes(["Xtigervnc", "websockify"]);

    expect(procs.sort((a, b) => a.pid - b.pid)).toEqual([
      {
        pid: 10,
        argv: ["Xtigervnc", ":100", "-rfbport", "5901"],
        env: { ROME_DESKTOP: "notes" },
      },
      {
        pid: 11,
        argv: ["/usr/bin/python3", "/usr/bin/websockify", "127.0.0.1:6081", "localhost:5901"],
        env: { A: "b=c" },
      },
    ]);
  });

  it("reads and clears X lock state", async () => {
    await mkdir(join(root, "tmp", ".X11-unix"), { recursive: true });
    await writeFile(join(root, "tmp", ".X100-lock"), "      4242\n");
    const system = nodeDesktopSystem({ tmpDir: join(root, "tmp") });

    expect(await system.xLockOwner(100)).toBe(4242);
    expect(await system.xLockOwner(101)).toBeNull();
    expect(await system.xSocketExists(100)).toBe(false);

    await system.removeXState(100);
    expect(await system.xLockOwner(100)).toBeNull();
  });

  it("counts an exited pid and an unreaped zombie as dead", async () => {
    await fakeProcess(4242, ["Xtigervnc"], []);
    await fakeProcess(4244, ["Xtigervnc"], [], "Z");
    const system = nodeDesktopSystem({ procDir: join(root, "proc") });
    expect(system.pidAlive(4242)).toBe(true);
    expect(system.pidAlive(4243)).toBe(false);
    expect(system.pidAlive(4244)).toBe(false);
  });

  it("sees a loopback listener", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const system = nodeDesktopSystem();
    try {
      expect(await system.portListening(port)).toBe(true);
    } finally {
      server.close();
    }
    await once(server, "close");
    expect(await system.portListening(port)).toBe(false);
  });

  it("finds programs on PATH", async () => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "Xtigervnc"), "#!/bin/sh\n", { mode: 0o755 });
    const system = nodeDesktopSystem({ pathEnv: bin });
    expect(await system.hasProgram("Xtigervnc")).toBe(true);
    expect(await system.hasProgram("openbox")).toBe(false);
  });

  it("spawns a detached process that logs to its file and reports its exit", async () => {
    const system = nodeDesktopSystem();
    const logFile = join(root, "out.log");
    const spawned = await system.spawnDetached(
      "sh",
      ["-c", 'echo "started as $ROME_DESKTOP"; exit 3'],
      { PATH: process.env.PATH ?? "", ROME_DESKTOP: "notes" },
      logFile,
    );
    expect(spawned.pid).toBeGreaterThan(0);
    for (let i = 0; i < 100 && !spawned.exited(); i++) await system.sleep(20);

    expect(spawned.exited()).toBe(true);
    expect(await readFile(logFile, "utf8")).toBe("started as notes\n");
    expect(await system.tail(logFile)).toBe("started as notes");
    expect(await system.tail(join(root, "missing.log"))).toBe("");
  });

  it("rejects a program that cannot be spawned", async () => {
    const system = nodeDesktopSystem();
    await expect(
      system.spawnDetached("rome-no-such-program", [], {}, join(root, "x.log")),
    ).rejects.toThrow();
  });
});
