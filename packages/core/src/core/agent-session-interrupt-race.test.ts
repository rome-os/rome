import { afterEach, describe, expect, it } from "@rstest/core";
import { createSessionFromRun, type ModelSession } from "./agent-runner.js";
import { createTestRome, type TestRome } from "../test/kit/index.js";

// A Stop that lands while a provider is still starting its turn. A provider
// can ignore an interrupt until it knows its own turn id (Codex does, until
// turn/start answers), so the session sends the interrupt again once the send
// has resolved.
describe("AgentSession interrupt during the send", () => {
  let rome: TestRome | undefined;

  afterEach(async () => {
    await rome?.cleanup();
    rome = undefined;
  });

  it("interrupts the provider again once the send resolves, when the first interrupt could not land", async () => {
    rome = await createTestRome();
    const channelThreadKey = "webchat:interrupt-race";
    let sent = false;
    const interrupts: Array<{ reason?: string; landed: boolean }> = [];
    rome.model.openSession = async (params) => {
      const inner = createSessionFromRun("mock", (runParams) => rome!.model.run(runParams), params);
      const session: ModelSession = Object.create(inner);
      const sendUserInput = inner.sendUserInput.bind(inner);
      session.sendUserInput = async (input) => {
        // Stop arrives while the provider is still starting the turn.
        await rome!.agentSessionManager
          .peek({ agentName: "main", channelThreadKey })
          ?.interrupt("user-stop");
        await sendUserInput(input);
        sent = true;
      };
      // The provider ignores an interrupt until its send has resolved.
      session.interrupt = async (reason) => {
        interrupts.push({ reason, landed: sent });
      };
      return session;
    };

    const messages = await rome.runAgent({ prompt: "go", channelThreadKey });

    expect(interrupts.some((interrupt) => interrupt.landed)).toBe(true);
    expect(messages.some((message) => message.type === "turn_end")).toBe(true);
  });
});
