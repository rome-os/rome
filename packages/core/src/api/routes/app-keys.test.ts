import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { EventEmitter } from "node:events";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import { AppKeyInjector } from "../../app-keys/injector.js";
import { ActionEngine } from "../../actions/engine.js";
import { ActionRegistryImpl } from "../../actions/registry.js";
import { appKeysRoutes } from "./app-keys.js";

describe("appKeysRoutes", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", appKeysRoutes(deps));
  });

  afterEach(() => {
    testDb.close();
  });

  const put = (name: string, body: unknown) =>
    app.request(`/app-keys/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores a key, injects it, and lists it without the value", async () => {
    const res = await put("MY_DB_PASSWORD", { label: "Shop DB password", value: "hunter2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, overridden: false });

    const list = await app.request("/app-keys");
    expect(list.status).toBe(200);
    const payload = (await list.json()) as {
      keys: Array<{ name: string; label: string; overridden: boolean; updatedAt: string }>;
    };
    expect(payload.keys).toHaveLength(1);
    expect(payload.keys[0].name).toBe("MY_DB_PASSWORD");
    expect(payload.keys[0].label).toBe("Shop DB password");
    expect(payload.keys[0].overridden).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("hunter2");
  });

  it("rejects reserved and malformed names", async () => {
    for (const name of ["ROME_PROFILE", "PATH", "lowercase"]) {
      const res = await put(name, { value: "v" });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a missing value", async () => {
    const res = await put("MY_KEY", { label: "no value" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Value is required/);
  });

  it("defaults the label to the name", async () => {
    await put("MY_KEY", { value: "v" });
    const payload = (await (await app.request("/app-keys")).json()) as {
      keys: Array<{ label: string }>;
    };
    expect(payload.keys[0].label).toBe("MY_KEY");
  });

  it("reports overridden when the process environment already owns the name", async () => {
    const env: NodeJS.ProcessEnv = { TAKEN_KEY: "from-operator" };
    deps.appKeyInjector = new AppKeyInjector(env);
    app = new Hono().route("/", appKeysRoutes(deps));

    const res = await put("TAKEN_KEY", { value: "from-dashboard" });
    expect(await res.json()).toEqual({ ok: true, overridden: true });
    expect(env.TAKEN_KEY).toBe("from-operator");

    const list = (await (await app.request("/app-keys")).json()) as {
      keys: Array<{ overridden: boolean }>;
    };
    expect(list.keys[0].overridden).toBe(true);
  });

  it("recycles the warm action-worker pool so new workers fork with the current env", async () => {
    // Warm workers snapshot process.env at fork time and are reused, so a
    // saved or deleted key must retire the pool to reach action code. This
    // drives the real pool through the fork seam and asserts each generation's
    // captured env.
    const TEST_KEY = "APP_KEYS_WORKER_REFRESH_PROBE";

    class FakeWorkerChild extends EventEmitter {
      pid = 4242;
      connected = true;
      exitCode: number | null = null;
      send(message: unknown, cb?: (err: Error | null) => void): boolean {
        cb?.(null);
        if ((message as { type?: unknown }).type === "shutdown") {
          this.connected = false;
          this.exitCode = 0;
          queueMicrotask(() => this.emit("exit", 0, null));
        }
        return true;
      }
      kill(): boolean {
        return true;
      }
    }

    const forkedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const children: FakeWorkerChild[] = [];
    const engine = new ActionEngine(
      new ActionRegistryImpl([]),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        processRole: "main",
        workerWarmPoolSize: 1,
        actionWorkerFork: (_entryPath: string, options: ForkOptions) => {
          forkedEnvs.push(options.env);
          const child = new FakeWorkerChild();
          children.push(child);
          return child as unknown as ChildProcess;
        },
      },
    );
    deps.actionEngine = engine;
    deps.refreshAppRuntime = () => engine.restartWorkerWarmPool();
    // The engine snapshots the real process.env at fork time, so the injector
    // must write there for the test to observe propagation.
    deps.appKeyInjector = new AppKeyInjector();
    app = new Hono().route("/", appKeysRoutes(deps));

    try {
      engine.startWorkerWarmPool();
      expect(children).toHaveLength(1);
      children[0].emit("message", { type: "ready" });
      expect(forkedEnvs[0]?.[TEST_KEY]).toBeUndefined();

      const saved = await put(TEST_KEY, { value: "v1" });
      expect(saved.status).toBe(200);
      expect(children).toHaveLength(2);
      expect(forkedEnvs[1]?.[TEST_KEY]).toBe("v1");
      children[1].emit("message", { type: "ready" });

      const del = await app.request(`/app-keys/${TEST_KEY}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(children).toHaveLength(3);
      expect(forkedEnvs[2]?.[TEST_KEY]).toBeUndefined();
    } finally {
      await engine.stopWorkerWarmPool();
      delete process.env[TEST_KEY];
    }
  });

  it("refreshes the app runtime only when the environment changed", async () => {
    const refresh = rs.spyOn(deps, "refreshAppRuntime");

    const rejected = await put("lowercase", { value: "v" });
    expect(rejected.status).toBe(400);
    expect(refresh).not.toHaveBeenCalled();

    const saved = await put("MY_KEY", { value: "v1" });
    expect(saved.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);

    const removed = await app.request("/app-keys/MY_KEY", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(2);

    // A shadowed save changes nothing in the environment, so no refresh.
    const env: NodeJS.ProcessEnv = { TAKEN_KEY: "from-operator" };
    deps.appKeyInjector = new AppKeyInjector(env);
    app = new Hono().route("/", appKeysRoutes(deps));
    const shadowed = await put("TAKEN_KEY", { value: "from-dashboard" });
    expect(await shadowed.json()).toEqual({ ok: true, overridden: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("deletes a key and 404s on an unknown one", async () => {
    await put("MY_KEY", { value: "v" });
    const del = await app.request("/app-keys/MY_KEY", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(
      ((await (await app.request("/app-keys")).json()) as { keys: unknown[] }).keys,
    ).toHaveLength(0);

    const missing = await app.request("/app-keys/MY_KEY", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});
