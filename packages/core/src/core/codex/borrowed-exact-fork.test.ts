import { describe, expect, it, rs } from "@rstest/core";
import type { ModelSessionForkOpenParams, ModelSessionForkParams } from "../agent-runner.js";
import {
  createBorrowedExactForkSession,
  evaluateBorrowedExactFork,
} from "./borrowed-exact-fork.js";
import type { RomeDynamicToolCallResult } from "./rome-dynamic-tools.js";

function openParams(
  overrides: Partial<ModelSessionForkOpenParams> = {},
): ModelSessionForkOpenParams {
  return {
    model: "gpt-5.6-terra",
    systemPrompt: "system",
    workingDir: "/workspace",
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "delegated",
    ...overrides,
  };
}

function evaluate(
  forkOverrides: Partial<ModelSessionForkParams> = {},
  openOverrides: Partial<ModelSessionForkOpenParams> = {},
) {
  return evaluateBorrowedExactFork({
    forkParams: {
      sessionId: "fork-session",
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
    ["model", { model: "gpt-5.6-sol" }, "sameModel"],
    ["system prompt", { systemPrompt: "different" }, "sameSystemPrompt"],
    ["working directory", { workingDir: "/other" }, "sameWorkingDir"],
  ] as const)("rejects an exact fork with a different %s", (_label, overrides, mismatch) => {
    const result = evaluate({}, overrides);
    expect(result.eligible).toBe(false);
    expect(result[mismatch]).toBe(false);
  });
});

describe("createBorrowedExactForkSession", () => {
  it("scopes dynamic tools to the fork runtime and rolls back", async () => {
    const rollbackTurn = rs.fn(async () => undefined);
    let hasForkActionTool = false;
    const session = await createBorrowedExactForkSession({
      providerId: "openai",
      forkSessionId: "fork-session",
      sourceThreadId: "source-thread",
      openParams: openParams(),
      runExclusive: async (work) => await work(),
      runTurn: async (_input, runtime) => {
        hasForkActionTool = runtime.romeTools.hasTool("execute_action");
        await runtime.beforeTerminal?.({ threadId: "source-thread", turnId: "fork-turn" });
        runtime.sink.push({ type: "result", content: "done" });
      },
      rollbackTurn,
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
    expect(rollbackTurn).toHaveBeenCalledWith("source-thread");
  });

  // A webchat-sourced exact fork opens with supportsInteractiveSurface: true
  // (the advertised catalog must stay byte-identical to the source) and
  // interactiveSurfaceDetached: true (nothing drains the fork stream to mount
  // cards or resolve handbacks). The borrowed turn's dynamic-tool runtime must
  // carry the detached flag through, or the interactive tools claim UI was
  // delivered that no one will ever see. Facade-level detached behavior is
  // covered in mcp-facade.routine-draft.test.ts; this pins the wire-through.
  it("keeps a webchat-sourced fork's interactive dynamic tools detached", async () => {
    let advertised: readonly string[] = [];
    let askRes: RomeDynamicToolCallResult | undefined;
    let confirmRes: RomeDynamicToolCallResult | undefined;
    const session = await createBorrowedExactForkSession({
      providerId: "openai",
      forkSessionId: "fork-session",
      sourceThreadId: "source-thread",
      openParams: openParams({
        supportsInteractiveSurface: true,
        interactiveSurfaceDetached: true,
        handback: { schema: { type: "object", properties: {} } },
      }),
      runExclusive: async (work) => await work(),
      runTurn: async (_input, runtime) => {
        advertised = runtime.romeTools.definitions.map((tool) => tool.name);
        askRes = await runtime.romeTools.callTool("ask_question", {
          questions: [{ id: "city", question: "Which city?", type: "text" }],
        });
        confirmRes = await runtime.romeTools.callTool("confirm_output", {});
        runtime.sink.push({ type: "result", content: "done" });
      },
      rollbackTurn: async () => undefined,
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
    expect(advertised).toEqual(
      expect.arrayContaining(["ask_question", "propose_routine", "confirm_output"]),
    );
    // Runtime honesty: ask_question relays prose instead of parking the
    // turn on a card no drain will mount ...
    expect(askRes!.traceOutput.content[0].text).not.toContain("pendingInteraction");
    expect(askRes!.traceOutput.content[0].text).toContain("Which city?");
    // ... and confirm_output refuses instead of claiming a handback shipped.
    expect(confirmRes!.traceOutput.isError).toBe(true);
    expect(confirmRes!.traceOutput.content[0].text).toContain("nothing was shipped");
  });
});
