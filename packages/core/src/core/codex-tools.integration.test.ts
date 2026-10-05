import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import type { ModelSessionParams } from "./agent-runner.js";
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

/**
 * The tool part of a Responses request. Codex has moved tools between the
 * top-level `tools` field and nested `additional_tools` input items, so this
 * reads both and matches names as text instead of relying on one layout.
 */
interface ResponsesRequest {
  model: string;
  tools?: unknown;
  input?: Array<{ type?: string }>;
}

function toolText(body: ResponsesRequest): string {
  const extra = (body.input ?? []).filter((item) => item.type === "additional_tools");
  return JSON.stringify([body.tools ?? [], extra]);
}

/**
 * Smoke the bundled Codex binary through Rome's own provider. A Codex upgrade
 * can drop a tool without any error (#629 lost update_plan this way). Each
 * turn's request to the mock gateway carries the model's tool list.
 */
describe("bundled Codex app-server", () => {
  const requests: Array<{ model: string; tools: string }> = [];
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
        requests.push({ model: body.model, tools: toolText(body) });
        const item = {
          type: "message",
          role: "assistant",
          id: "msg-1",
          content: [{ type: "output_text", text: "ok" }],
        };
        const events = [
          { type: "response.created", response: { id: "resp-1" } },
          { type: "response.output_item.done", item },
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

  it.each(codexModels)("gives %s the tools Rome relies on", async (model) => {
    const params: ModelSessionParams = {
      model,
      systemPrompt: "Integration-test thread; do not modify files.",
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      sessionId: `codex-tools-${model}`,
      isNewSession: true,
      workingDir: home,
      executeAction: async () => ({ ok: true }),
      executeSubagent: async () => "unused",
    };
    const romeTools = createRomeDynamicTools(params).definitions.map((tool) => tool.name);
    const session = await provider.openSession(params);
    try {
      await session.sendUserInput({ text: "Reply with ok." });
      for await (const event of session.events) {
        if (event.type === "result") break;
      }
    } finally {
      await session.close();
    }

    const request = requests.find((entry) => entry.model === model);
    expect(request, `no request for ${model}`).toBeDefined();
    const missing = [...CODEX_TOOLS, ...romeTools].filter(
      (tool) => !new RegExp(`\\b${tool}\\b`).test(request!.tools),
    );
    expect(missing, `Codex dropped tools for ${model}`).toEqual([]);
  }, 30_000);
});
