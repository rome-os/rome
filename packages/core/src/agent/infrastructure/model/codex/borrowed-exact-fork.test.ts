import { describe, expect, it, rs } from "@rstest/core";
import type { ModelSessionConfig, ModelSessionParams } from "../../../domain/model-port.js";
import {
  createBorrowedExactForkSession,
  evaluateBorrowedExactFork,
} from "./borrowed-exact-fork.js";
import { createRomeDynamicTools, type RomeDynamicToolCallResult } from "./rome-dynamic-tools.js";
import { createRomeTools } from "../../../../core/mcp/server.js";
import type { FacadeParams } from "../../../../core/mcp-facade.js";

type OpenOverrides = Partial<Omit<ModelSessionParams, "config" | "tools">> & {
  config?: Partial<ModelSessionConfig>;
  /** What the session's Rome tools are built from. */
  tools?: Partial<FacadeParams>;
};

type McpServers = ModelSessionConfig["externalMcpServers"];

function openParams(overrides: OpenOverrides = {}): ModelSessionParams {
  const { config, tools, ...rest } = overrides;
  return {
    config: {
      model: "gpt-5.6-terra",
      systemPrompt: "system",
      builtinTools: [],
      workingDir: "/workspace",
      ...config,
    },
    tools: createRomeTools({
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      executeAction: async () => ({ ok: true }),
      executeSubagent: async () => "delegated",
      ...tools,
    }),
    thread: { kind: "new" },
    ...rest,
  };
}

function evaluate(openOverrides: OpenOverrides = {}, sourceExternalMcpServers?: McpServers) {
  return evaluateBorrowedExactFork({
    openParams: openParams(openOverrides),
    sourceConfig: { ...openParams().config, externalMcpServers: sourceExternalMcpServers },
    sourceDynamicTools: createRomeDynamicTools(openParams().tools).definitions,
  });
}

describe("evaluateBorrowedExactFork", () => {
  it("accepts a branch with the source's whole configuration and catalog", () => {
    expect(evaluate()).toEqual({
      eligible: true,
      sameModel: true,
      sameSystemPrompt: true,
      sameWorkingDir: true,
      sameTools: true,
      sameTurnSettings: true,
    });
  });

  it.each([
    ["model", { config: { model: "gpt-5.6-sol" } }, "sameModel"],
    ["system prompt", { config: { systemPrompt: "different" } }, "sameSystemPrompt"],
    ["working directory", { config: { workingDir: "/other" } }, "sameWorkingDir"],
    ["builtin tool set", { config: { builtinTools: ["Bash"] } }, "sameTools"],
    ["output schema", { config: { outputSchema: { type: "object" } } }, "sameTurnSettings"],
    ["reasoning effort", { config: { reasoningEffort: "high" } }, "sameTurnSettings"],
    ["shell environment", { config: { env: { ROME_CHANNEL: "webchat" } } }, "sameTurnSettings"],
    [
      "tools catalog",
      {
        tools: {
          subagentTools: [
            { name: "reviewer", description: "Review", inputSchema: { type: "object" } },
          ],
        },
      },
      "sameTools",
    ],
  ] as const)("rejects a branch with a different %s", (_label, overrides, mismatch) => {
    const result = evaluate(overrides as OpenOverrides);
    expect(result.eligible).toBe(false);
    expect(result[mismatch]).toBe(false);
  });
});

describe("evaluateBorrowedExactFork with external MCP servers", () => {
  it("rejects a branch that leaves out the source's servers", () => {
    const servers: McpServers = { docs: { command: "docs-mcp", args: [] } };
    expect(evaluate({}, servers)).toMatchObject({ eligible: false, sameTools: false });
    expect(evaluate({ config: { externalMcpServers: servers } }, servers).eligible).toBe(true);
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
        runtime.sink.push({ type: "result", content: "done", reasoningEffort: "high" });
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
        tools: {
          supportsInteractiveSurface: true,
          interactiveSurfaceDetached: true,
        },
      }),
      runExclusive: async (work) => await work(),
      runTurn: async (_input, runtime) => {
        advertised = runtime.romeTools.definitions.map((tool) => tool.name);
        askRes = await runtime.romeTools.callTool("ask_question", {
          questions: [{ id: "city", question: "Which city?", type: "text" }],
        });
        runtime.sink.push({ type: "result", content: "done", reasoningEffort: "high" });
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
        runtime.sink.push({ type: "result", content: "done", reasoningEffort: "high" });
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
