import { describe, expect, it } from "@rstest/core";
import { DesktopManager, DesktopUnavailable, isDesktopName } from "./manager.js";
import type { DesktopSystem, ProcessInfo } from "./system.js";

interface Spawn {
  program: string;
  args: string[];
  env: Record<string, string>;
  logFile: string;
}

/**
 * An in-memory machine. A spawned Xtigervnc owns its display's lock and socket
 * and listens on its RFB port; a spawned websockify listens on its port. A
 * program in `failing` exits at once, and `missing` programs are not installed.
 */
function fakeSystem(
  state: {
    procs?: ProcessInfo[];
    locks?: Map<number, number>;
    alive?: Set<number>;
    ports?: Set<number>;
    failing?: Set<string>;
    missing?: Set<string>;
  } = {},
) {
  const procs = state.procs ?? [];
  const locks = state.locks ?? new Map<number, number>();
  const alive = state.alive ?? new Set<number>();
  const ports = state.ports ?? new Set<number>();
  const sockets = new Set<number>();
  const removed: number[] = [];
  const spawns: Spawn[] = [];
  let nextPid = 1_000;

  const system: DesktopSystem = {
    processes: async (programs) =>
      procs.filter((proc) =>
        proc.argv.slice(0, 2).some((arg) => programs.includes(arg.split("/").pop()!)),
      ),
    xLockOwner: async (display) => locks.get(display) ?? null,
    pidAlive: (pid) => alive.has(pid),
    removeXState: async (display) => {
      removed.push(display);
      locks.delete(display);
      sockets.delete(display);
    },
    xSocketExists: async (display) => sockets.has(display),
    portListening: async (port) => ports.has(port),
    hasProgram: async (program) => !state.missing?.has(program),
    spawnDetached: async (program, args, env, logFile) => {
      spawns.push({ program, args, env, logFile });
      const pid = nextPid++;
      if (state.failing?.has(program)) return { pid, exited: () => true };
      procs.push({ pid, argv: [program, ...args], env });
      alive.add(pid);
      if (program === "Xtigervnc") {
        const display = Number(args[0]!.slice(1));
        locks.set(display, pid);
        sockets.add(display);
        ports.add(Number(args[args.indexOf("-rfbport") + 1]));
      }
      if (program === "websockify") ports.add(Number(args[0]!.split(":")[1]));
      return { pid, exited: () => false };
    },
    tail: async (logFile) => `last lines of ${logFile}`,
    sleep: async () => {},
  };
  return { system, procs, spawns, removed, ports, locks, alive };
}

function manager(fake: ReturnType<typeof fakeSystem>, pins = {}) {
  return new DesktopManager({ system: fake.system, pins, logDir: "/logs", readyTimeoutMs: 1_000 });
}

describe("isDesktopName", () => {
  it("accepts short lower-case names and reserves the shared socket path", () => {
    expect(isDesktopName("wechat")).toBe(true);
    expect(isDesktopName("notes-2")).toBe(true);
    expect(isDesktopName("websockify")).toBe(false);
    expect(isDesktopName("WeChat")).toBe(false);
    expect(isDesktopName("2d")).toBe(false);
    expect(isDesktopName("a".repeat(33))).toBe(false);
    expect(isDesktopName("../x")).toBe(false);
  });
});

describe("DesktopManager.acquire", () => {
  it("starts a desktop on the first free slot, loopback-only and marked with its name", async () => {
    const fake = fakeSystem();
    const desktop = await manager(fake).acquire("notes", { openboxConfig: "/rc.xml" });

    expect(desktop).toEqual({
      name: "notes",
      display: ":100",
      vncPort: 5901,
      novncPort: 6081,
      path: "/desktop/notes",
    });
    expect(fake.spawns.map((spawn) => spawn.program)).toEqual([
      "Xtigervnc",
      "openbox",
      "websockify",
    ]);
    const [x, openbox, websockify] = fake.spawns;
    expect(x!.args).toEqual(
      expect.arrayContaining([":100", "-localhost", "yes", "-rfbport", "5901", "1280x800"]),
    );
    expect(x!.logFile).toBe("/logs/xtigervnc-notes.log");
    expect(openbox!.args).toEqual(["--config-file", "/rc.xml"]);
    expect(openbox!.env.DISPLAY).toBe(":100");
    expect(websockify!.args).toEqual(["127.0.0.1:6081", "localhost:5901"]);
    for (const spawn of fake.spawns) expect(spawn.env.ROME_DESKTOP).toBe("notes");
  });

  it("passes the display processes none of Rome's own configuration", async () => {
    process.env.ROME_TEST_SECRET = "s3cret";
    try {
      const fake = fakeSystem();
      await manager(fake).acquire("notes");
      for (const spawn of fake.spawns) expect(spawn.env.ROME_TEST_SECRET).toBeUndefined();
    } finally {
      delete process.env.ROME_TEST_SECRET;
    }
  });

  it("adopts a running desktop instead of starting a second one", async () => {
    const fake = fakeSystem();
    const first = await manager(fake).acquire("notes");
    // A new manager stands for Rome after a restart: it has only the process table.
    const second = await manager(fake).acquire("notes");

    expect(second).toEqual(first);
    expect(fake.spawns).toHaveLength(3);
  });

  it("starts only the missing process of a partly running desktop", async () => {
    const fake = fakeSystem();
    await manager(fake).acquire("notes");
    const index = fake.procs.findIndex((proc) => proc.argv[0] === "websockify");
    fake.procs.splice(index, 1);
    fake.ports.delete(6081);

    await manager(fake).acquire("notes");

    expect(fake.spawns.map((spawn) => spawn.program)).toEqual([
      "Xtigervnc",
      "openbox",
      "websockify",
      "websockify",
    ]);
  });

  it("gives each name its own slot", async () => {
    const fake = fakeSystem();
    const desktops = manager(fake);
    const [a, b] = await Promise.all([desktops.acquire("a"), desktops.acquire("b")]);

    expect([a.display, b.display]).toEqual([":100", ":101"]);
    expect([b.vncPort, b.novncPort]).toEqual([5902, 6082]);
  });

  it("starts a name once when acquired concurrently", async () => {
    const fake = fakeSystem();
    const desktops = manager(fake);
    await Promise.all([desktops.acquire("notes"), desktops.acquire("notes")]);
    expect(fake.spawns).toHaveLength(3);
  });

  it("passes over slots held by a live X server, a busy port or another name's pin", async () => {
    const fake = fakeSystem({
      locks: new Map([[101, 77]]),
      alive: new Set([77]),
      ports: new Set([5903]),
    });
    const desktop = await manager(fake, {
      wechat: { display: 100, vncPort: 5901, novncPort: 6081 },
    }).acquire("notes");

    expect(desktop.display).toBe(":103");
    expect(fake.removed).toEqual([103]);
  });

  it("returns to the slot where its own websockify outlived its X server", async () => {
    const fake = fakeSystem({
      procs: [
        {
          pid: 20,
          argv: ["websockify", "127.0.0.1:6083", "localhost:5903"],
          env: { ROME_DESKTOP: "notes" },
        },
      ],
      locks: new Map([[102, 19]]),
      ports: new Set([6083]),
    });
    const desktop = await manager(fake).acquire("notes");

    expect(desktop.display).toBe(":102");
    expect(fake.spawns.map((spawn) => spawn.program)).toEqual(["Xtigervnc", "openbox"]);
    expect(fake.removed).toEqual([102]);
  });

  it("does not take a slot whose websockify belongs to another name", async () => {
    const fake = fakeSystem({
      procs: [
        {
          pid: 20,
          argv: ["websockify", "127.0.0.1:6081", "localhost:5901"],
          env: { ROME_DESKTOP: "other" },
        },
      ],
      ports: new Set([6081]),
    });
    expect((await manager(fake).acquire("notes")).display).toBe(":101");
  });

  it("clears a stale X lock left by a dead server and reuses its slot", async () => {
    const fake = fakeSystem({ locks: new Map([[100, 55]]) });
    const desktop = await manager(fake).acquire("notes");

    expect(desktop.display).toBe(":100");
    expect(fake.removed).toEqual([100]);
  });

  it("adopts the entrypoint's unmarked display for a pinned name", async () => {
    const fake = fakeSystem({
      procs: [
        { pid: 10, argv: ["Xtigervnc", ":100", "-rfbport", "5901"], env: {} },
        { pid: 11, argv: ["openbox"], env: { DISPLAY: ":100" } },
        {
          pid: 12,
          argv: ["/usr/bin/python3", "/usr/bin/websockify", "127.0.0.1:6081", "localhost:5901"],
          env: {},
        },
      ],
    });
    const desktop = await manager(fake, {
      wechat: { display: 100, vncPort: 5901, novncPort: 6081 },
    }).acquire("wechat");

    expect(desktop.display).toBe(":100");
    expect(fake.spawns).toEqual([]);
  });

  it("starts a pinned name on its pin", async () => {
    const fake = fakeSystem();
    const desktop = await manager(fake, {
      wechat: { display: 120, vncPort: 5950, novncPort: 6150 },
    }).acquire("wechat");

    expect(desktop).toMatchObject({ display: ":120", vncPort: 5950, novncPort: 6150 });
  });

  it("refuses a pinned slot held by an X server that is not Rome's", async () => {
    const fake = fakeSystem({ locks: new Map([[100, 77]]), alive: new Set([77]) });
    await expect(
      manager(fake, { wechat: { display: 100, vncPort: 5901, novncPort: 6081 } }).acquire("wechat"),
    ).rejects.toThrow("The existing X server on :100 is not Rome's TigerVNC process");
    expect(fake.spawns).toEqual([]);
  });

  it("refuses a pinned slot whose port another process holds", async () => {
    const fake = fakeSystem({ ports: new Set([5901]) });
    await expect(
      manager(fake, { wechat: { display: 100, vncPort: 5901, novncPort: 6081 } }).acquire("wechat"),
    ).rejects.toThrow("TCP port 5901 is already in use by another process");
  });

  it("reports a process that exits during startup with its log", async () => {
    const fake = fakeSystem({ failing: new Set(["Xtigervnc"]) });
    await expect(manager(fake).acquire("notes")).rejects.toThrow(
      "TigerVNC exited during startup: last lines of /logs/xtigervnc-notes.log",
    );
  });

  it("reports Openbox exiting at once", async () => {
    const fake = fakeSystem({ failing: new Set(["openbox"]) });
    await expect(manager(fake).acquire("notes")).rejects.toThrow("Openbox exited during startup");
  });

  it("is unavailable where the desktop stack is not installed", async () => {
    const fake = fakeSystem({ missing: new Set(["Xtigervnc"]) });
    await expect(manager(fake).acquire("notes")).rejects.toBeInstanceOf(DesktopUnavailable);
    expect(fake.spawns).toEqual([]);
  });

  it("rejects an invalid name or geometry", async () => {
    const fake = fakeSystem();
    await expect(manager(fake).acquire("websockify")).rejects.toThrow("Invalid desktop name");
    await expect(manager(fake).acquire("notes", { geometry: "big" })).rejects.toThrow(
      "Invalid desktop geometry",
    );
  });
});

describe("DesktopManager.get", () => {
  it("finds a running desktop and never starts one", async () => {
    const fake = fakeSystem();
    expect(await manager(fake).get("notes")).toBeNull();
    expect(fake.spawns).toEqual([]);

    await manager(fake).acquire("notes");
    expect(await manager(fake).get("notes")).toMatchObject({ display: ":100", novncPort: 6081 });
    expect(await manager(fake).get("other")).toBeNull();
    expect(await manager(fake).get("websockify")).toBeNull();
  });

  it("does not count a desktop whose websockify is down", async () => {
    const fake = fakeSystem();
    await manager(fake).acquire("notes");
    fake.procs.splice(
      fake.procs.findIndex((proc) => proc.argv[0] === "websockify"),
      1,
    );
    expect(await manager(fake).get("notes")).toBeNull();
  });

  it("does not adopt another name's marked display", async () => {
    const fake = fakeSystem();
    await manager(fake).acquire("notes");
    expect(await manager(fake).get("wechat")).toBeNull();
  });
});
