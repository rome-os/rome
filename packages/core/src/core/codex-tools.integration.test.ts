import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { ModelSession, ModelSessionParams } from "./agent-runner.js";
import { CodexAppServerProvider } from "./codex-app-server-provider.js";
import { CodexAppServerManager } from "./codex/app-server-manager.js";
import { createRomeDynamicTools } from "./codex/rome-dynamic-tools.js";
import {
  ROME_CREDITS_MODEL_PROVIDER_ID,
  ROME_CREDITS_TOKEN_ENV,
} from "./codex/rome-credits-provider.js";
import { WEBCHAT_LARGE_MODEL_SELECTIONS } from "./model-selector.js";

const codexModels = Object.values(WEBCHAT_LARGE_MODEL_SELECTIONS)
  .filter((selection) => selection.providerId === "openai")
  .map((selection) => selection.model);

// Codex tools Rome renders: plan updates, commands and file changes.
const CODEX_TOOLS = ["update_plan", "exec_command", "apply_patch"];
// Codex tools that read the filesystem or run commands, which an agent with
// no builtins must not get.
const CODEX_SHELL_TOOLS = ["exec_command", "write_stdin", "view_image"];
// Every Codex tool an agent with no builtins may get, beside Rome's own. This is
// an allowlist so that a Codex upgrade adding or renaming a tool fails here
// until someone decides whether `tools` must switch it off. Code mode's exec
// and wait run JavaScript that reaches only the tools offered here, and the
// read-only sandbox rejects apply_patch. Namespace names count as tools.
const CODEX_TOOLS_WITHOUT_BUILTINS = new Set([
  "functions",
  "exec",
  "wait",
  "apply_patch",
  "update_plan",
  "request_user_input",
  "request_user_input_async",
  "create_goal",
  "get_goal",
  "update_goal",
  "clock",
  "clock__curr_time",
  "sleep",
  "collaboration",
  "spawn_agent",
  "send_message",
  "followup_task",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
]);

interface ResponsesRequest {
  model: string;
  tools?: unknown;
  input?: Array<{ type?: string }>;
}

/** Output items the mock gateway returns, or undefined for a plain "ok". */
type Script = (body: ResponsesRequest) => Array<Record<string, unknown>> | undefined;

const hasToolOutput = (body: ResponsesRequest) =>
  (body.input ?? []).some((item) => item.type?.endsWith("_output"));

/**
 * Names of the tools a Responses request offers. Codex has moved tools between
 * the top-level `tools` field and nested `additional_tools` input items, and
 * Codex 0.160 declares most of them inside the `exec` tool's description as
 * `declare const tools: { name(`. Prose that mentions a tool doesn't count.
 */
function toolNames(body: ResponsesRequest): string[] {
  const part = [
    body.tools ?? [],
    (body.input ?? []).filter((item) => item.type === "additional_tools"),
  ];
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const { name } = value as { name?: unknown };
      if (typeof name === "string") names.add(name);
      Object.values(value).forEach(walk);
    }
  };
  walk(part);
  for (const match of JSON.stringify(part).matchAll(/declare const tools: \{ (\w+)\(/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

/**
 * Smoke the bundled Codex binary through Rome's own provider. A Codex upgrade
 * can drop a tool without any error (#629 lost update_plan this way). Each
 * turn's request to the mock gateway carries the model's tool list.
 */
describe("bundled Codex app-server", () => {
  const requests: Array<{ model: string; tools: string[]; input: string }> = [];
  let script: Script | undefined;
  let home: string;
  let gateway: ReturnType<typeof createServer>;
  let provider: CodexAppServerProvider;
  let previousOrigin: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "rome-codex-tools-"));
    gateway = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as ResponsesRequest;
        requests.push({
          model: body.model,
          tools: toolNames(body),
          input: JSON.stringify(body.input ?? []),
        });
        const items = script?.(body) ?? [
          {
            type: "message",
            role: "assistant",
            id: "msg-1",
            content: [{ type: "output_text", text: "ok" }],
          },
        ];
        const events = [
          { type: "response.created", response: { id: "resp-1" } },
          ...items.map((item) => ({ type: "response.output_item.done", item })),
          {
            type: "response.completed",
            response: {
              id: "resp-1",
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
                total_tokens: 2,
              },
            },
          },
        ];
        const sse = events
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join("");
        response.writeHead(200, { "content-type": "text/event-stream" }).end(sse);
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("mock gateway did not bind");
    previousOrigin = process.env.PANTHEON_BASE_ORIGIN;
    process.env.PANTHEON_BASE_ORIGIN = `http://127.0.0.1:${address.port}`;
    provider = new CodexAppServerProvider({
      appServerManager: new CodexAppServerManager({
        cwd: home,
        env: {
          HOME: home,
          CODEX_HOME: home,
          PATH: process.env.PATH ?? "",
          [ROME_CREDITS_TOKEN_ENV]: "romeinst_integration_test_token",
        },
        defaultProvider: ROME_CREDITS_MODEL_PROVIDER_ID,
      }),
    });
  }, 30_000);

  afterAll(async () => {
    provider.close();
    if (previousOrigin === undefined) delete process.env.PANTHEON_BASE_ORIGIN;
    else process.env.PANTHEON_BASE_ORIGIN = previousOrigin;
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const sessionParams = (
    model: string,
    sessionId: string,
    builtinTools: string[],
  ): ModelSessionParams => ({
    model,
    systemPrompt: "Integration-test thread; do not modify files.",
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    builtinTools,
    sessionId,
    isNewSession: true,
    workingDir: home,
    executeAction: async () => ({ ok: true }),
    executeSubagent: async () => "unused",
  });

  /** Runs one turn and returns the tools of the last request that carried `text`. */
  async function runTurn(session: ModelSession, text: string): Promise<string[]> {
    await session.sendUserInput({ text });
    for await (const event of session.events) {
      if (event.type === "error") throw new Error(`Codex turn failed: ${event.error}`);
      if (event.type === "result") break;
    }
    const request = requests.filter((entry) => entry.input.includes(text)).at(-1);
    expect(request, `no request carried ${text}`).toBeDefined();
    return request!.tools;
  }

  const fullBuiltins = () => [...provider.builtinTools];

  it.each(codexModels)("gives %s the tools Rome relies on", async (model) => {
    const params = sessionParams(model, `codex-tools-${model}`, fullBuiltins());
    const romeTools = createRomeDynamicTools(params).definitions.map((tool) => tool.name);
    const session = await provider.openSession(params);
    let tools: string[];
    try {
      tools = await runTurn(session, `Reply with ok. (${model}, every builtin)`);
    } finally {
      await session.close();
    }

    const missing = [...CODEX_TOOLS, ...romeTools].filter((tool) => !tools.includes(tool));
    expect(missing, `Codex dropped tools for ${model}`).toEqual([]);
  }, 30_000);

  it.each(codexModels)("gives %s no shell when the agent declares no builtins", async (model) => {
    const params = sessionParams(model, `codex-no-builtins-${model}`, []);
    const romeTools = createRomeDynamicTools(params).definitions.map((tool) => tool.name);
    const session = await provider.openSession(params);
    let tools: string[];
    try {
      tools = await runTurn(session, `Reply with ok. (${model}, no builtins)`);
    } finally {
      await session.close();
    }

    expect(tools.filter((tool) => CODEX_SHELL_TOOLS.includes(tool))).toEqual([]);
    const unexpected = tools.filter(
      (tool) => !romeTools.includes(tool) && !CODEX_TOOLS_WITHOUT_BUILTINS.has(tool),
    );
    expect(unexpected, `Codex offered unreviewed tools to ${model}`).toEqual([]);
    const missing = ["update_plan", ...romeTools].filter((tool) => !tools.includes(tool));
    expect(missing, `Codex dropped Rome tools for ${model}`).toEqual([]);
  }, 30_000);

  it("takes the shell away when a thread that had it resumes with no builtins", async () => {
    const model = codexModels[0]!;
    const first = await provider.openSession(sessionParams(model, "codex-resume", fullBuiltins()));
    let threadId: string | undefined;
    try {
      expect(await runTurn(first, "Reply with ok. (before resume)")).toContain("exec_command");
      threadId = first.providerThreadId;
    } finally {
      await first.close();
    }

    const resumed = await provider.openSession({
      ...sessionParams(model, "codex-resume", []),
      isNewSession: false,
      providerThreadId: threadId,
    });
    try {
      const tools = await runTurn(resumed, "Reply with ok. (after resume)");
      expect(resumed.providerThreadId).toBe(threadId);
      expect(tools.filter((tool) => CODEX_SHELL_TOOLS.includes(tool))).toEqual([]);
    } finally {
      await resumed.close();
    }
  }, 30_000);

  it("gives an isolated fork no shell even when its source had one", async () => {
    const model = codexModels[0]!;
    const source = await provider.openSession(
      sessionParams(model, "codex-fork-source", fullBuiltins()),
    );
    try {
      await runTurn(source, "Reply with ok. (fork source)");
      const fork = await source.fork({ sessionId: "codex-fork-child", mode: "thread" });
      const {
        sessionId: _sessionId,
        isNewSession: _isNewSession,
        ...openParams
      } = sessionParams(model, "codex-fork-child", fullBuiltins());
      const child = await fork.open(openParams);
      try {
        const tools = await runTurn(child, "Reply with ok. (isolated fork)");
        expect(child.providerThreadId).not.toBe(source.providerThreadId);
        expect(tools.filter((tool) => CODEX_SHELL_TOOLS.includes(tool))).toEqual([]);
      } finally {
        await child.close();
      }
    } finally {
      await source.close();
    }
  }, 30_000);

  // apply_patch stays on every thread, so the sandbox is what blocks writes.
  // The Write case shows the scripted patch would land if allowed.
  it.each([
    { name: "rejects a patch from an agent with no builtins", builtinTools: [], written: false },
    { name: "applies a patch from an agent with Write", builtinTools: ["Write"], written: true },
  ])("$name", async ({ builtinTools, written }) => {
    const file = `patched-${builtinTools.length}.txt`;
    const patch = `*** Begin Patch\n*** Add File: ${file}\n+hi\n*** End Patch\n`;
    script = (body) =>
      hasToolOutput(body)
        ? undefined
        : [
            {
              type: "custom_tool_call",
              call_id: "call-patch",
              name: "exec",
              input: `text(await tools.apply_patch(${JSON.stringify(patch)}));`,
            },
          ];
    const session = await provider.openSession(
      sessionParams(codexModels[0]!, `codex-patch-${file}`, builtinTools),
    );
    try {
      await runTurn(session, `Apply the patch. (${file})`);
    } finally {
      script = undefined;
      await session.close();
    }

    const exists = await access(join(home, file)).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(written);
  }, 30_000);

  // No config key removes Codex's collaboration tools from models that ship
  // them, so a spawned Codex agent has to inherit the parent's limits.
  it("gives a Codex agent spawned by an agent with no builtins no shell", async () => {
    const parentPrompt = "Spawn a child agent.";
    const childTask = "Child task: reply with ok.";
    // The parent's follow-up request repeats the spawn call, so only a request
    // without the parent's prompt is the child's.
    const isChild = (entry: { input: string }) =>
      entry.input.includes(childTask) && !entry.input.includes(parentPrompt);
    script = (body) => {
      const input = JSON.stringify(body.input ?? []);
      if (input.includes(childTask) || hasToolOutput(body)) return undefined;
      return [
        {
          type: "function_call",
          call_id: "call-spawn",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: JSON.stringify({ task_name: "child", message: childTask, fork_turns: "none" }),
        },
      ];
    };
    const session = await provider.openSession(sessionParams("gpt-5.6-terra", "codex-spawn", []));
    try {
      const parentTools = await runTurn(session, parentPrompt);
      expect(parentTools).toContain("spawn_agent");
      await rs.waitFor(() => expect(requests.some(isChild)).toBe(true), { timeout: 10_000 });
    } finally {
      script = undefined;
      await session.close();
    }

    const child = requests.find(isChild)!;
    expect(child.tools.filter((tool) => CODEX_SHELL_TOOLS.includes(tool))).toEqual([]);
  }, 30_000);
});
