import { describe, expect, it } from "@rstest/core";
import type { AgentTurnFinishedEvent } from "@rome-os/app-runtime";
import { TurnListeners } from "./turn-listeners.js";

const ended = (turnId: string): AgentTurnFinishedEvent => ({
  type: "agent-turn-finished",
  version: 1,
  turn: { sessionId: "s", turnId, agentName: "main" },
  status: "completed",
  timing: { startedAt: "", finishedAt: "", durationMs: 0 },
  output: { text: "", state: "final" },
  metrics: { toolCallCount: 0, skillWritten: false },
});

describe("TurnListeners", () => {
  it("tells Rome's listeners in the order they listened, then the app hooks", () => {
    const heard: string[] = [];
    const listeners = new TurnListeners({
      started: () => {
        heard.push("apps started");
        return { invoked: 0, skipped: 0, skips: [] };
      },
      ended: () => {
        heard.push("apps ended");
        return { invoked: 0, skipped: 0, skips: [] };
      },
    });
    listeners.listen({ ended: () => heard.push("first") });
    listeners.listen({
      ended: () => {
        throw new Error("a listener that throws is skipped");
      },
    });
    listeners.listen({ ended: () => heard.push("third") });

    listeners.ended(ended("turn-1"));

    expect(heard).toEqual(["first", "third", "apps ended"]);
  });

  it("tells only Rome's listeners of a turn that could not start, and stops telling one that left", () => {
    const heard: string[] = [];
    const listeners = new TurnListeners({
      started: () => ({ invoked: 0, skipped: 0, skips: [] }),
      ended: () => {
        heard.push("apps");
        return { invoked: 0, skipped: 0, skips: [] };
      },
    });
    const stop = listeners.listen({ couldNotStart: (event) => heard.push(event.error) });

    listeners.couldNotStart({
      turn: { sessionId: "s", turnId: "t", agentName: "main" },
      error: "no model",
    });
    stop();
    listeners.couldNotStart({
      turn: { sessionId: "s", turnId: "t", agentName: "main" },
      error: "again",
    });

    expect(heard).toEqual(["no model"]);
  });
});
