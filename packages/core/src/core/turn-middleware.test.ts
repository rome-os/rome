import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTurnMiddlewareChain } from "./turn-middleware.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactRef } from "../apps/state.js";
import type {
  AgentEvent,
  TurnMiddlewareContext,
  TurnMiddlewareHook,
  TurnMiddlewareNext,
  TurnOutcome,
} from "@rome-os/app-runtime";

// The outcome a model turn that ran to the end reports.
const completed = (): TurnOutcome => ({ status: "completed", suspended: false });

describe("TurnMiddlewareChain", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("runs the terminal directly when no middleware is loaded (passthrough)", async () => {
    const chain = createTurnMiddlewareChain();
    expect(chain.size()).toBe(0);

    let terminalRan = false;
    await chain.run(
      makeCtx(),
      async () => {
        terminalRan = true;
      },
      completed,
    );
    expect(terminalRan).toBe(true);
  });

  it("lets a passthrough middleware reach the terminal", async () => {
    // A middleware that simply calls next() must not block the model.
    const dir = await createMiddlewareDir(
      "passthrough",
      `{ order: 0, async handle(ctx, next) { await next(); } }`,
    );
    const chain = createTurnMiddlewareChain();
    expect(await chain.loadFromCatalog(catalogWithHooks([hookRef("app.pass", dir)]))).toEqual([]);
    expect(chain.size()).toBe(1);

    let terminalRan = false;
    await chain.run(
      makeCtx(),
      async () => {
        terminalRan = true;
      },
      completed,
    );
    expect(terminalRan).toBe(true);
  });

  it("short-circuits the model when a middleware does not call next()", async () => {
    const dir = await createMiddlewareDir(
      "scripted",
      `{
        order: 0,
        async handle(ctx, next) {
          if (ctx.session.agentName !== "welcome-to-rome") { await next(); return; }
          ctx.emit({ type: "text", content: "scripted reply" });
          ctx.emit({ type: "result", content: "scripted reply" });
        },
      }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(catalogWithHooks([hookRef("app.scripted", dir)]));

    // Matching session → short-circuit, terminal never runs.
    const emitted: AgentEvent[] = [];
    let terminalRan = false;
    await chain.run(
      makeCtx("welcome-to-rome", emitted),
      async () => {
        terminalRan = true;
      },
      completed,
    );
    expect(terminalRan).toBe(false);
    expect(emitted.map((m) => m.type)).toEqual(["text", "result"]);

    // Non-matching session → passthrough to the model terminal.
    let otherTerminalRan = false;
    await chain.run(
      makeCtx("main"),
      async () => {
        otherTerminalRan = true;
      },
      completed,
    );
    expect(otherTerminalRan).toBe(true);
  });

  it("resolves next() with how the inner turn ended", async () => {
    const dir = await createMiddlewareDir(
      "outcome",
      `{
        order: 0,
        async handle(ctx, next) {
          const outcome = await next();
          ctx.emit({ type: "text", content: JSON.stringify(outcome) });
        },
      }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(catalogWithHooks([hookRef("app.outcome", dir)]));

    const emitted: AgentEvent[] = [];
    let terminalRan = false;
    await chain.run(
      makeCtx("main", emitted),
      async () => {
        terminalRan = true;
      },
      () => ({ status: "interrupted", suspended: false }),
    );

    expect(terminalRan).toBe(true);
    expect(emitted).toEqual([
      { type: "text", content: JSON.stringify({ status: "interrupted", suspended: false }) },
    ]);
  });

  it("requires an outcome reader, so next() never resolves with nothing", async () => {
    const chain = createTurnMiddlewareChain();
    // @ts-expect-error a turn chain cannot run without its outcome reader
    await chain.run(makeCtx(), async () => {});
  });

  it("types next() as possibly empty, since older hosts resolve it with nothing", () => {
    const readStatus = async (next: TurnMiddlewareNext) => {
      // @ts-expect-error a middleware must check the outcome before reading it
      return (await next()).status;
    };
    expect(typeof readStatus).toBe("function");
  });

  it("accepts a passthrough middleware that returns next()", () => {
    const passthrough: TurnMiddlewareHook = {
      order: 0,
      async handle(_ctx, next) {
        return next();
      },
    };
    expect(passthrough.order).toBe(0);
  });

  it("lets a middleware rewrite the input before the terminal reads it", async () => {
    const dir = await createMiddlewareDir(
      "rewrite",
      `{
        order: 0,
        async handle(ctx, next) {
          ctx.input.prompt = "[rewritten] " + ctx.input.prompt;
          await next();
        },
      }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(catalogWithHooks([hookRef("app.rewrite", dir)]));

    const ctx = makeCtx();
    let seen = "";
    await chain.run(
      ctx,
      async () => {
        seen = ctx.input.prompt;
      },
      completed,
    );
    expect(seen).toBe("[rewritten] hello");
  });

  it("orders middlewares by declared order, outermost first", async () => {
    const outer = await createMiddlewareDir(
      "outer",
      `{ order: 0, async handle(ctx, next) { ctx.input.prompt += ":outer-in"; await next(); ctx.input.prompt += ":outer-out"; } }`,
    );
    const inner = await createMiddlewareDir(
      "inner",
      `{ order: 10, async handle(ctx, next) { ctx.input.prompt += ":inner-in"; await next(); ctx.input.prompt += ":inner-out"; } }`,
    );
    const chain = createTurnMiddlewareChain();
    // Register inner before outer to prove sort order — not registration order — wins.
    await chain.loadFromCatalog(
      catalogWithHooks([hookRef("app.inner", inner), hookRef("app.outer", outer)]),
    );

    const ctx = makeCtx("main");
    ctx.input.prompt = "x";
    await chain.run(
      ctx,
      async () => {
        ctx.input.prompt += ":model";
      },
      completed,
    );
    expect(ctx.input.prompt).toBe("x:outer-in:inner-in:model:inner-out:outer-out");
  });

  it("fails open by default: a throwing middleware is skipped and the chain continues", async () => {
    const boom = await createMiddlewareDir(
      "boom",
      `{ order: 0, async handle() { throw new Error("kaboom"); } }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(catalogWithHooks([hookRef("app.boom", boom)]));

    let terminalRan = false;
    await chain.run(
      makeCtx(),
      async () => {
        terminalRan = true;
      },
      completed,
    );
    expect(terminalRan).toBe(true);
  });

  it("fails closed when the middleware declares onError fail-closed", async () => {
    const boom = await createMiddlewareDir(
      "boom-closed",
      `{ order: 0, onError: "fail-closed", async handle() { throw new Error("hard stop"); } }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(catalogWithHooks([hookRef("app.boomclosed", boom)]));

    let terminalRan = false;
    await expect(
      chain.run(
        makeCtx(),
        async () => {
          terminalRan = true;
        },
        completed,
      ),
    ).rejects.toThrow("hard stop");
    expect(terminalRan).toBe(false);
  });

  it("keeps a failure a middleware recovered from out of the layers around it", async () => {
    const outer = await createMiddlewareDir(
      "recover-outer",
      `{
        order: 0,
        async handle(ctx, next) {
          const outcome = await next();
          ctx.emit({ type: "text", content: "outer saw " + outcome.status });
        },
      }`,
    );
    const recovering = await createMiddlewareDir(
      "recover-middle",
      `{
        order: 1,
        onError: "fail-closed",
        async handle(ctx, next) {
          try {
            await next();
          } catch {
            ctx.emit({ type: "text", content: "fallback" });
          }
        },
      }`,
    );
    const failing = await createMiddlewareDir(
      "recover-inner",
      `{ order: 2, onError: "fail-closed", async handle() { throw new Error("inner broke"); } }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(
      catalogWithHooks([
        hookRef("app.outer", outer),
        hookRef("app.recovering", recovering),
        hookRef("app.failing", failing),
      ]),
    );

    const emitted: AgentEvent[] = [];
    await chain.run(makeCtx("main", emitted), async () => {}, completed);

    expect(emitted).toEqual([
      { type: "text", content: "fallback" },
      { type: "text", content: "outer saw completed" },
    ]);
  });

  it("makes an unawaited inner failure the failure of the middleware that started it", async () => {
    const detached = await createMiddlewareDir(
      "detached",
      `{
        order: 0,
        onError: "fail-closed",
        async handle(ctx, next) {
          void next();
        },
      }`,
    );
    const failing = await createMiddlewareDir(
      "detached-inner",
      `{
        order: 1,
        onError: "fail-closed",
        async handle() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("late failure");
        },
      }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(
      catalogWithHooks([hookRef("app.detached", detached), hookRef("app.late", failing)]),
    );

    await expect(chain.run(makeCtx(), async () => {}, completed)).rejects.toThrow("late failure");
  });

  it("reports an inner failure the middleware never looked at, however fast it came", async () => {
    const busy = await createMiddlewareDir(
      "unobserved",
      `{
        order: 0,
        onError: "fail-closed",
        async handle(ctx, next) {
          void next();
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      }`,
    );
    const failing = await createMiddlewareDir(
      "unobserved-inner",
      `{ order: 1, onError: "fail-closed", async handle() { throw new Error("fast failure"); } }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(
      catalogWithHooks([hookRef("app.busy", busy), hookRef("app.fast", failing)]),
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(chain.run(makeCtx(), async () => {}, completed)).rejects.toThrow("fast failure");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("leaves an inner failure to the middleware that caught what next() returned", async () => {
    const catching = await createMiddlewareDir(
      "observed",
      `{
        order: 0,
        onError: "fail-closed",
        async handle(ctx, next) {
          void next().catch(() => ctx.emit({ type: "text", content: "caught" }));
        },
      }`,
    );
    const failing = await createMiddlewareDir(
      "observed-inner",
      `{
        order: 1,
        onError: "fail-closed",
        async handle() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("late failure");
        },
      }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(
      catalogWithHooks([hookRef("app.catching", catching), hookRef("app.late", failing)]),
    );

    const emitted: AgentEvent[] = [];
    await chain.run(makeCtx("main", emitted), async () => {}, completed);
    expect(emitted).toEqual([{ type: "text", content: "caught" }]);
  });

  it.each([
    ["then(onFulfilled)", "void next().then(() => {});"],
    ["finally", "void next().finally(() => {});"],
  ])("reports an inner failure behind %s as the middleware's own", async (_label, call) => {
    const busy = await createMiddlewareDir(
      "derived",
      `{
        order: 0,
        onError: "fail-closed",
        async handle(ctx, next) {
          ${call}
        },
      }`,
    );
    const failing = await createMiddlewareDir(
      "derived-inner",
      `{ order: 1, onError: "fail-closed", async handle() { throw new Error("inner broke"); } }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(
      catalogWithHooks([hookRef("app.busy", busy), hookRef("app.failing", failing)]),
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(chain.run(makeCtx(), async () => {}, completed)).rejects.toThrow("inner broke");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it.each([
    ["await next().finally(cleanup)", "await next().finally(() => {});"],
    ["await next().then(post).catch(recover)", "await next().then(() => {}).catch(() => {});"],
  ])("lets a middleware recover through %s", async (_label, call) => {
    const outer = await createMiddlewareDir(
      "derived-recover-outer",
      `{
        order: 0,
        async handle(ctx, next) {
          const outcome = await next();
          ctx.emit({ type: "text", content: "outer saw " + outcome.status });
        },
      }`,
    );
    const recovering = await createMiddlewareDir(
      "derived-recover",
      `{
        order: 1,
        onError: "fail-closed",
        async handle(ctx, next) {
          try {
            ${call}
          } catch {}
          ctx.emit({ type: "text", content: "recovered" });
        },
      }`,
    );
    const failing = await createMiddlewareDir(
      "derived-recover-inner",
      `{ order: 2, onError: "fail-closed", async handle() { throw new Error("inner broke"); } }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(
      catalogWithHooks([
        hookRef("app.outer", outer),
        hookRef("app.recovering", recovering),
        hookRef("app.failing", failing),
      ]),
    );

    const emitted: AgentEvent[] = [];
    await chain.run(makeCtx("main", emitted), async () => {}, completed);
    expect(emitted).toEqual([
      { type: "text", content: "recovered" },
      { type: "text", content: "outer saw completed" },
    ]);
  });

  it("waits for the layers a throwing middleware started before its error leaves", async () => {
    const outer = await createMiddlewareDir(
      "drain-outer",
      `{
        order: 0,
        async handle(ctx, next) {
          try {
            await next();
          } catch {}
          ctx.emit({ type: "text", content: "outer done" });
        },
      }`,
    );
    const throwing = await createMiddlewareDir(
      "drain-middle",
      `{
        order: 1,
        onError: "fail-closed",
        async handle(ctx, next) {
          void next().catch(() => {});
          throw new Error("middle broke");
        },
      }`,
    );
    const slow = await createMiddlewareDir(
      "drain-inner",
      `{
        order: 2,
        async handle(ctx, next) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          ctx.emit({ type: "text", content: "inner done" });
          await next();
        },
      }`,
    );
    const chain = createTurnMiddlewareChain();
    await chain.loadFromCatalog(
      catalogWithHooks([
        hookRef("app.outer", outer),
        hookRef("app.throwing", throwing),
        hookRef("app.slow", slow),
      ]),
    );

    const emitted: AgentEvent[] = [];
    await chain.run(makeCtx("main", emitted), async () => {}, completed);

    expect(emitted).toEqual([
      { type: "text", content: "inner done" },
      { type: "text", content: "outer done" },
    ]);
  });

  it("reports artifacts that do not implement handle()", async () => {
    const dir = await createMiddlewareDir("invalid", `{ order: 0 }`);
    const chain = createTurnMiddlewareChain();
    const failures = await chain.loadFromCatalog(catalogWithHooks([hookRef("app.invalid", dir)]));
    expect(failures).toEqual([
      expect.objectContaining({ appId: "app.invalid", error: expect.stringContaining("handle") }),
    ]);
    expect(chain.size()).toBe(0);
  });

  async function createMiddlewareDir(name: string, hookLiteral: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `rome-turnmw-${name}-`));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "index.js"),
      `export function createHook(deps) { return ${hookLiteral}; }\n`,
      "utf-8",
    );
    return dir;
  }
});

function makeCtx(agentName = "main", emitInto: AgentEvent[] = []): TurnMiddlewareContext {
  return {
    input: { prompt: "hello" },
    session: { id: "session-1", agentName, channelThreadKey: `webchat:${agentName}` },
    emit: (event) => emitInto.push(event),
    meta: {},
  };
}

function hookRef(ownerId: string, absolutePath: string): ArtifactRef {
  return {
    kind: "hook",
    publicName: "turn-middleware",
    aliases: [],
    ownerType: "app",
    ownerId,
    absolutePath,
  };
}

function catalogWithHooks(hooks: ArtifactRef[]): AppCatalog {
  return {
    get() {
      return null;
    },
    listArtifacts(kind: string) {
      return kind === "hook" ? hooks : [];
    },
  } as unknown as AppCatalog;
}
