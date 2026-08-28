import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTurnMiddlewareChain } from "./turn-middleware.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactRef } from "../apps/state.js";
import type { AgentMessage, TurnMiddlewareContext } from "@rome-os/app-runtime";

describe("TurnMiddlewareChain", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("runs the terminal directly when no middleware is loaded (passthrough)", async () => {
    const chain = createTurnMiddlewareChain();
    expect(chain.size()).toBe(0);

    let terminalRan = false;
    await chain.run(makeCtx(), async () => {
      terminalRan = true;
    });
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
    await chain.run(makeCtx(), async () => {
      terminalRan = true;
    });
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
    const emitted: AgentMessage[] = [];
    let terminalRan = false;
    await chain.run(makeCtx("welcome-to-rome", emitted), async () => {
      terminalRan = true;
    });
    expect(terminalRan).toBe(false);
    expect(emitted.map((m) => m.type)).toEqual(["text", "result"]);

    // Non-matching session → passthrough to the model terminal.
    let otherTerminalRan = false;
    await chain.run(makeCtx("main"), async () => {
      otherTerminalRan = true;
    });
    expect(otherTerminalRan).toBe(true);
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
    await chain.run(ctx, async () => {
      seen = ctx.input.prompt;
    });
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
    await chain.run(ctx, async () => {
      ctx.input.prompt += ":model";
    });
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
    await chain.run(makeCtx(), async () => {
      terminalRan = true;
    });
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
      chain.run(makeCtx(), async () => {
        terminalRan = true;
      }),
    ).rejects.toThrow("hard stop");
    expect(terminalRan).toBe(false);
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

function makeCtx(agentName = "main", emitInto: AgentMessage[] = []): TurnMiddlewareContext {
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
