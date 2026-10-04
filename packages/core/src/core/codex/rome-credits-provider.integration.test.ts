import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { CodexAppServerManager, type CodexThreadBinding } from "./app-server-manager.js";
import { Method, type ThreadStartParams } from "./app-server-protocol.js";
import { ROME_CREDITS_MODEL_PROVIDER_ID, ROME_CREDITS_TOKEN_ENV } from "./rome-credits-provider.js";

const TOKEN = "romeinst_integration_test_token";

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    try {
      if ((await stat(path)).isDirectory()) found.push(...(await filesContaining(path, needle)));
      else if ((await readFile(path)).includes(needle)) found.push(path);
    } catch {
      // SQLite side files can vanish while the app-server exits.
    }
  }
  return found;
}

/**
 * Smoke the bundled Codex binary: after a payer replacement, a resumed thread
 * follows the replacement process default.
 */
describe("Rome credits provider on the bundled Codex app-server", () => {
  it("routes a thread to the gateway after a payer replacement", async () => {
    const home = await mkdtemp(join(tmpdir(), "rome-codex-credits-"));
    const authorizations: string[] = [];
    const gateway = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      authorizations.push(request.headers.authorization ?? "");
      request.resume();
      const message = {
        type: "message",
        role: "assistant",
        id: `msg-${authorizations.length}`,
        content: [{ type: "output_text", text: "ok" }],
      };
      const events = [
        { type: "response.created", response: { id: `resp-${authorizations.length}` } },
        { type: "response.output_item.done", item: message },
        {
          type: "response.completed",
          response: {
            id: `resp-${authorizations.length}`,
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
      const body = events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
      response.writeHead(200, { "content-type": "text/event-stream" }).end(body);
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string") throw new Error("mock gateway did not bind");

    const completions: Array<{ threadId: string; status: string }> = [];
    const waiters: Array<() => void> = [];
    const binding: CodexThreadBinding = {
      onNotification(method, params) {
        if (method !== "turn/completed") return;
        const { threadId, turn } = params as { threadId: string; turn: { status: string } };
        completions.push({ threadId, status: turn.status });
        waiters.shift()?.();
      },
      async onDynamicToolCall() {
        return { contentItems: [], success: false };
      },
      onExit() {},
    };
    const previousOrigin = process.env.PANTHEON_BASE_ORIGIN;
    process.env.PANTHEON_BASE_ORIGIN = `http://127.0.0.1:${address.port}`;
    const newManager = () =>
      new CodexAppServerManager({
        cwd: home,
        env: {
          HOME: home,
          CODEX_HOME: home,
          PATH: process.env.PATH ?? "",
          [ROME_CREDITS_TOKEN_ENV]: TOKEN,
        },
        defaultProvider: ROME_CREDITS_MODEL_PROVIDER_ID,
      });
    const config: ThreadStartParams = {
      model: "gpt-5.6-terra",
      cwd: home,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      baseInstructions: "Integration-test thread; do not modify files.",
      config: { model_reasoning_summary: "detailed", hide_agent_reasoning: false },
      historyMode: "paginated",
      dynamicTools: null,
    };
    const runTurn = async (manager: CodexAppServerManager, threadId: string) => {
      const completed = new Promise<void>((resolve) => waiters.push(resolve));
      await manager.requestForThread(threadId, Method.turnStart, {
        threadId,
        input: [{ type: "text", text: "Reply with ok.", text_elements: [] }],
      });
      await completed;
    };

    const manager = newManager();
    try {
      const { threadId } = await manager.openThread(config, binding);
      await runTurn(manager, threadId);

      await manager.setDefaultProvider(null);
      await manager.setDefaultProvider(ROME_CREDITS_MODEL_PROVIDER_ID);
      await runTurn(manager, threadId);

      expect(completions).toEqual([
        { threadId, status: "completed" },
        { threadId, status: "completed" },
      ]);
      expect(authorizations).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);

      // command/exec builds its env with the same shell environment policy
      // as the agent's shell tool, so it shows what an agent command sees.
      const shell = await manager.request<{ exitCode: number; stdout: string }>("command/exec", {
        command: ["sh", "-c", `printenv ${ROME_CREDITS_TOKEN_ENV}; echo exit=$?`],
        cwd: home,
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      expect(shell.stdout).not.toContain(TOKEN);
      expect(shell.stdout.trim()).toBe("exit=1");
      manager.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await filesContaining(home, TOKEN)).toEqual([]);
    } finally {
      manager.close();
      if (previousOrigin === undefined) delete process.env.PANTHEON_BASE_ORIGIN;
      else process.env.PANTHEON_BASE_ORIGIN = previousOrigin;
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }, 60_000);
});
