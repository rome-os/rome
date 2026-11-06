import { describe, expect, it, rs } from "@rstest/core";
import type {
  ModelPrefix,
  ModelSessionForkOpenParams,
  ModelSessionForkParams,
} from "../../../domain/model-port.js";
import {
  createBorrowedExactForkSession,
  evaluateBorrowedExactFork,
} from "./borrowed-exact-fork.js";
import type { RomeDynamicToolCallResult } from "./rome-dynamic-tools.js";

type OpenOverrides = Partial<Omit<ModelSessionForkOpenParams, "prefix">> & {
  prefix?: Partial<ModelPrefix>;
};

function openParams(overrides: OpenOverrides = {}): ModelSessionForkOpenParams {
  const { prefix, ...rest } = overrides;
  return {
    prefix: {
      model: "gpt-5.6-terra",
      systemPrompt: "system",
      builtinTools: [],
      workingDir: "/workspace",
      ...prefix,
    },
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "delegated",
    ...rest,
  };
}

function evaluate(
  forkOverrides: Partial<ModelSessionForkParams> = {},
  openOverrides: OpenOverrides = {},
) {
  return evaluateBorrowedExactFork({
    forkParams: {
      configurationMode: "exact",
      ...forkOverrides,
    },
    openParams: openParams(openOverrides),
    sourceModelName: "gpt-5.6-terra",
    sourceSystemPrompt: "system",
    sourceWorkingDir: "/workspace",
  });
}

describe("evaluateBorrowedExactFork", () => {
  it("accepts an explicitly exact fork with identical provider configuration", () => {
    expect(evaluate()).toEqual({
      eligible: true,
      sameModel: true,
      sameSystemPrompt: true,
      sameWorkingDir: true,
    });
  });

  it("never borrows an isolated fork even when model, prompt, and cwd match", () => {
    expect(evaluate({ configurationMode: "isolated" })).toMatchObject({
      eligible: false,
      sameModel: true,
      sameSystemPrompt: true,
      sameWorkingDir: true,
    });
  });

  it.each([
    ["model", { prefix: { model: "gpt-5.6-sol" } }, "sameModel"],
    ["system prompt", { prefix: { systemPrompt: "different" } }, "sameSystemPrompt"],
    ["working directory", { prefix: { workingDir: "/other" } }, "sameWorkingDir"],
  ] as const)("rejects an exact fork with a different %s", (_label, overrides, mismatch) => {
    const result = evaluate({}, overrides);
    expect(result.eligible).toBe(false);
    expect(result[mismatch]).toBe(false);
  });
});

describe("createBorrowedExactForkSession", () => {
  it("scopes dynamic tools to the fork runtime and reverts before the borrowed turn", async () => {
    const revertTurn = rs.fn(async () => undefined);
    let hasForkActionTool = false;
    const session = await createBorrowedExactForkSession({
      providerId: "openai",
      forkOwnerId: "fork-owner",
      sourceThreadId: "source-thread",
      openParams: openParams(),
      runExclusive: async (work) => await work(),
      runTurn: async (_input, runtime) => {
        hasForkActionTool = runtime.romeTools.hasTool("execute_action");
        await runtime.beforeTerminal?.({ threadId: "source-thread", turnId: "fork-turn" });
        runtime.sink.push({ type: "result", content: "done" });
      },
      revertTurn,
      interrupt: async () => undefined,
    });

    const iterator = session.events[Symbol.asyncIterator]();
    await session.sendUserInput({ text: "feedback" });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "result", content: "done" },
    });
    await session.close();

    expect(hasForkActionTool).toBe(true);
    expect(revertTurn).toHaveBeenCalledWith("source-thread", "fork-turn");
  });

  // A webchat-sourced exact fork opens with supportsInteractiveSurface: true
  // (the advertised catalog must stay byte-identical to the source) and
  // interactiveSurfaceDetached: true (nothing drains the fork stream to mount
  // cards). The borrowed turn's dynamic-tool runtime must
  // carry the detached flag through, or the interactive tools claim UI was
  // delivered that no one will ever see. Facade-level detached behavior is
  // covered in mcp-facade.routine-draft.test.ts; this pins the wire-through.
  it("keeps a webchat-sourced fork's interactive dynamic tools detached", async () => {
    let advertised: readonly string[] = [];
    let askRes: RomeDynamicToolCallResult | undefined;
    const session = await createBorrowedExactForkSession({
      providerId: "openai",
      forkOwnerId: "fork-owner",
      sourceThreadId: "source-thread",
      openParams: openParams({
        supportsInteractiveSurface: true,
        interactiveSurfaceDetached: true,
      }),
      runExclusive: async (work) => await work(),
      runTurn: async (_input, runtime) => {
        advertised = runtime.romeTools.definitions.map((tool) => tool.name);
        askRes = await runtime.romeTools.callTool("ask_question", {
          questions: [{ id: "city", question: "Which city?", type: "text" }],
        });
        runtime.sink.push({ type: "result", content: "done" });
      },
      revertTurn: async () => undefined,
      interrupt: async () => undefined,
    });

    const iterator = session.events[Symbol.asyncIterator]();
    await session.sendUserInput({ text: "feedback" });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "result", content: "done" },
    });
    await session.close();

    // Prefix identity: the full interactive catalog stays advertised.
    expect(advertised).toEqual(expect.arrayContaining(["ask_question", "propose_routine"]));
    // Runtime honesty: ask_question relays prose instead of parking the
    // turn on a card no drain will mount.
    expect(askRes!.traceOutput.content[0].text).not.toContain("pendingInteraction");
    expect(askRes!.traceOutput.content[0].text).toContain("Which city?");
  });

  it("reports the input when it is sent, before it waits for the source's turns", async () => {
    const events: string[] = [];
    let release!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = await createBorrowedExactForkSession({
      providerId: "openai",
      forkOwnerId: "fork-owner",
      sourceThreadId: "source-thread",
      openParams: openParams(),
      runExclusive: async (work) => {
        await queued;
        return await work();
      },
      onSend: (input) => events.push(`sent:${input.text}`),
      runTurn: async (_input, runtime) => {
        events.push("ran");
        await runtime.beforeTerminal?.({ threadId: "source-thread", turnId: "fork-turn" });
        runtime.sink.push({ type: "result", content: "done" });
      },
      revertTurn: async () => undefined,
      interrupt: async () => undefined,
    });

    const iterator = session.events[Symbol.asyncIterator]();
    await session.sendUserInput({ text: "feedback" });
    expect(events).toEqual(["sent:feedback"]);
    release();
    await iterator.next();
    expect(events).toEqual(["sent:feedback", "ran"]);
    await session.close();
  });
});
