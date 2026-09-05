import { mkdtemp, rm } from "node:fs/promises";
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
    const client = new AppServerClient({
      cwd: home,
      env: {
        HOME: home,
        CODEX_HOME: home,
        PATH: process.env.PATH ?? "",
      },
      onNotification: () => undefined,
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

      const reverted = (await client.request(Method.threadRevert, {
        threadId: started.thread.id,
        beforeTurnId: turnStarted.turn.id,
      })) as { thread: { id: string; historyMode: string; turns: unknown[] } };
      expect(reverted.thread).toMatchObject({
        id: started.thread.id,
        historyMode: "paginated",
        turns: [],
      });
    } finally {
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
