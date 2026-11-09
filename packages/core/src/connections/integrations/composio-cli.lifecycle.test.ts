import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

// Mock the process + fs surface composio-cli.ts touches so the login/logout
// ceremony can be driven deterministically. (Kept in a separate file from
// composio-cli.test.ts, whose executableExistsOnPath test needs the real fs.)
const cp = rs.hoisted(() => ({ spawn: rs.fn(), execFile: rs.fn() }));
rs.mock("node:child_process", () => ({ spawn: cp.spawn, execFile: cp.execFile }));

const fsp = rs.hoisted(() => ({ readFile: rs.fn(), stat: rs.fn(), access: rs.fn() }));
rs.mock("node:fs/promises", () => ({
  readFile: fsp.readFile,
  stat: fsp.stat,
  access: fsp.access,
}));

import { getComposioStatus, logoutComposio, startComposioLogin } from "./composio-cli.js";

const LOGIN_URL = "https://dashboard.composio.dev/?cliKey=abc-00000000-0000-4000-8000-000000000000";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof rs.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // Killing a child (how logout tears the ceremony down) makes it exit.
  child.kill = rs.fn(() => {
    queueMicrotask(() => child.emit("exit", null));
    return true;
  });
  return child;
}

const spawned: Array<{ args: string[]; child: FakeChild }> = [];
let onPollSpawn: ((child: FakeChild) => void) | undefined;
let userDataJson: string | null;

/** Let the detached ceremony + async-mutex settle across several macrotasks. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("composio login ceremony lifecycle", () => {
  beforeEach(() => {
    spawned.length = 0;
    onPollSpawn = undefined;
    userDataJson = JSON.stringify({ api_key: null, base_url: "https://backend.composio.dev" });
    delete process.env.COMPOSIO_API_KEY;

    fsp.stat.mockReset().mockResolvedValue({ isFile: () => true });
    fsp.access.mockReset().mockResolvedValue(undefined);
    fsp.readFile.mockReset().mockImplementation(async (p: unknown) => {
      if (String(p).endsWith("user_data.json")) {
        if (userDataJson == null) throw new Error("ENOENT");
        return userDataJson;
      }
      throw new Error(`unexpected readFile ${String(p)}`);
    });

    cp.execFile
      .mockReset()
      .mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (e: unknown, o: string, s: string) => void,
        ) => {
          cb(null, "", "");
        },
      );

    cp.spawn.mockReset().mockImplementation((_cmd: string, args: string[]) => {
      const child = makeChild();
      spawned.push({ args, child });
      if (args.includes("--poll")) {
        onPollSpawn?.(child);
      } else {
        // `composio login`: print the URL then exit immediately (v0.2.32).
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(`Open this URL:\n  ${LOGIN_URL}\n`));
          queueMicrotask(() => child.emit("exit", 0));
        });
      }
      return child;
    });
  });

  afterEach(async () => {
    // Reset module state (ceremony) between tests.
    await logoutComposio().catch(() => {});
    await flush(2);
  });

  it("current CLI: mints URL, spawns --poll, and completes when the key lands", async () => {
    onPollSpawn = (child) => {
      queueMicrotask(() => {
        userDataJson = JSON.stringify({ api_key: "uak_live_test", base_url: "x" });
        child.emit("exit", 0);
      });
    };

    const { loginUrl } = await startComposioLogin();
    expect(loginUrl).toBe(LOGIN_URL);

    await flush();

    expect(spawned.map((s) => s.args)).toEqual([
      ["login", "--no-browser", "-y", "--no-skill-install"],
      ["login", "--poll", "-y", "--no-skill-install"],
    ]);
    const status = await getComposioStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.loginPending).toBe(false);
    expect(status.error).toBeNull();
  });

  it("legacy CLI: no --poll when the key is already persisted at login exit", async () => {
    // Simulate the blocking CLI: the key is on disk by the time `login` exits.
    cp.spawn.mockImplementation((_cmd: string, args: string[]) => {
      const child = makeChild();
      spawned.push({ args, child });
      queueMicrotask(() => {
        userDataJson = JSON.stringify({ api_key: "uak_legacy", base_url: "x" });
        child.stdout.emit("data", Buffer.from(`${LOGIN_URL}\n`));
        queueMicrotask(() => child.emit("exit", 0));
      });
      return child;
    });

    const { loginUrl } = await startComposioLogin();
    expect(loginUrl).toBe(LOGIN_URL);
    await flush();

    expect(spawned.map((s) => s.args)).toEqual([
      ["login", "--no-browser", "-y", "--no-skill-install"],
    ]);
    expect((await getComposioStatus()).loggedIn).toBe(true);
  });

  it("logout aborts an in-flight ceremony: kills --poll and logs out serially", async () => {
    // The poll never completes on its own — it only exits when killed.
    onPollSpawn = () => {};

    const { loginUrl } = await startComposioLogin();
    expect(loginUrl).toBe(LOGIN_URL);
    await flush();

    const poll = spawned.find((s) => s.args.includes("--poll"));
    expect(poll).toBeTruthy();

    await logoutComposio();

    expect(poll?.child.kill).toHaveBeenCalled();
    expect(cp.execFile).toHaveBeenCalledWith(
      "composio",
      ["logout"],
      expect.anything(),
      expect.any(Function),
    );
    const status = await getComposioStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.loginPending).toBe(false);
  });

  it("surfaces a completion failure when --poll exits without saving a key", async () => {
    onPollSpawn = (child) => {
      queueMicrotask(() => child.emit("exit", 1)); // exits, key still null
    };

    await startComposioLogin();
    await flush();

    const status = await getComposioStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.loginPending).toBe(false);
    expect(status.error).toMatch(/without saving credentials/);
  });
});
