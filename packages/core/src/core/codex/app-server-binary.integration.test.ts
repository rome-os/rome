import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { AppServerClient } from "./app-server-client.js";
import { Method } from "./app-server-protocol.js";

/**
 * Smoke the bundled Codex binary, not a mocked JSON-RPC peer. This pins the
 * paginated-history contract that Rome's borrowed exact forks depend on.
 */
describe("bundled Codex app-server", () => {
  it("starts an Astra thread and reverts its borrowed turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "rome-codex-app-server-"));
    const modelServer = createServer((request, response) => {
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      const events = [
        { type: "response.created", response: { id: "resp-1" } },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "msg-1",
            content: [{ type: "output_text", text: "ok" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp-1",
            usage: {
              input_tokens: 0,
              input_tokens_details: null,
              output_tokens: 0,
              output_tokens_details: null,
              total_tokens: 0,
            },
          },
        },
      ];
      const body = events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
      response.writeHead(200, { "content-type": "text/event-stream" }).end(body);
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const address = modelServer.address();
    if (!address || typeof address === "string") throw new Error("mock model server did not bind");
    await writeFile(
      join(home, "config.toml"),
      [
        'model = "gpt-6-astra"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'model_provider = "rome_test"',
        "",
        "[model_providers.rome_test]",
        'name = "Rome test provider"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "",
      ].join("\n"),
    );

    let resolveTurnCompleted!: (params: {
      threadId: string;
      turn: { id: string; status: string };
    }) => void;
    const turnCompleted = new Promise<{
      threadId: string;
      turn: { id: string; status: string };
    }>((resolve) => {
      resolveTurnCompleted = resolve;
    });
    const client = new AppServerClient({
      cwd: home,
      env: {
        HOME: home,
        CODEX_HOME: home,
        PATH: process.env.PATH ?? "",
      },
      onNotification: (method, params) => {
        if (method === "turn/completed") {
          resolveTurnCompleted(
            params as { threadId: string; turn: { id: string; status: string } },
          );
        }
      },
      onServerRequest: () => ({}),
    });

    try {
      client.start();
      await client.request(Method.initialize, {
        clientInfo: { name: "rome-test", title: "Rome test", version: "0" },
        capabilities: { experimentalApi: true },
      });
      client.notify(Method.initialized, {});

      const started = (await client.request(Method.threadStart, {
        model: "gpt-6-astra",
        cwd: home,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        baseInstructions: "Integration-test thread; do not modify files.",
        config: {
          model_reasoning_summary: "detailed",
          hide_agent_reasoning: false,
        },
        historyMode: "paginated",
        dynamicTools: null,
      })) as {
        thread: { id: string; model: string; historyMode: string; turns: unknown[] };
      };
      expect(started.thread).toMatchObject({
        model: "gpt-6-astra",
        historyMode: "paginated",
      });

      const turnStarted = (await client.request(Method.turnStart, {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Reply with ok.", text_elements: [] }],
        model: "gpt-6-astra",
        effort: "low",
        approvalPolicy: "never",
      })) as { turn: { id: string } };
      await expect(turnCompleted).resolves.toMatchObject({
        threadId: started.thread.id,
        turn: { id: turnStarted.turn.id, status: "completed" },
      });

      const beforeRevert = (await client.request(Method.threadTurnsList, {
        threadId: started.thread.id,
      })) as { data: Array<{ id: string }> };
      expect(beforeRevert.data.map((turn) => turn.id)).toEqual([turnStarted.turn.id]);

      const reverted = (await client.request(Method.threadRevert, {
        threadId: started.thread.id,
        beforeTurnId: turnStarted.turn.id,
      })) as { thread: { id: string; historyMode: string } };
      expect(reverted.thread).toMatchObject({
        id: started.thread.id,
        historyMode: "paginated",
      });
      const afterRevert = (await client.request(Method.threadTurnsList, {
        threadId: started.thread.id,
      })) as { data: unknown[] };
      expect(afterRevert.data).toEqual([]);
    } finally {
      client.close();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }, 30_000);
});
