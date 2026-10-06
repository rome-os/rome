import { describe, expect, it } from "@rstest/core";
import type { UsageEvent } from "./events.js";
import { UsageRecorder, type TurnUsageFacts } from "./recorder.js";

const finishedAt = new Date("2026-10-06T12:00:00.000Z");

function facts(overrides: Partial<TurnUsageFacts> = {}): TurnUsageFacts {
  return {
    turnId: "turn-1",
    romeSessionId: "chat-1",
    romeSessionType: "webchat",
    agentName: "main",
    status: "completed",
    provider: "openai",
    model: "gpt-6-sol",
    funding: "rome_credits",
    providerTurnId: "codex-turn-1",
    accounting: {
      provider: "openai",
      model: "gpt-6-sol",
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 },
      costUsd: 0.0042,
    },
    durationMs: 5300.4,
    finishedAt,
    ...overrides,
  };
}

function setup(reporting = true) {
  const queued: UsageEvent[] = [];
  const recorder = new UsageRecorder({
    outbox: { enqueue: async (event) => void queued.push(event) },
    attribution: { forTurn: async () => ({ kind: "chat", appId: null }) },
    isReporting: () => reporting,
  });
  return { recorder, queued };
}

describe("UsageRecorder", () => {
  it("queues one turn event carrying the accounting, funding, and provider turn id", async () => {
    const { recorder, queued } = setup();
    recorder.recordTurn(facts());
    await recorder.flush();
    expect(queued).toEqual([
      {
        type: "turn",
        eventId: "turn-1",
        kind: "chat",
        appId: null,
        status: "completed",
        provider: "openai",
        model: "gpt-6-sol",
        funding: "rome_credits",
        providerTurnId: "codex-turn-1",
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        estimatedCostMicros: "4200",
        durationMs: 5300,
        occurredAt: "2026-10-06T12:00:00.000Z",
      },
    ]);
  });

  it("records a turn that failed before any accounting as a zero-token turn", async () => {
    const { recorder, queued } = setup();
    recorder.recordTurn(
      facts({
        status: "error",
        accounting: undefined,
        funding: undefined,
        providerTurnId: undefined,
      }),
    );
    await recorder.flush();
    expect(queued[0]).toMatchObject({
      status: "error",
      provider: "openai",
      model: "gpt-6-sol",
      funding: "unknown",
      providerTurnId: null,
      inputTokens: 0,
      estimatedCostMicros: null,
    });
  });

  it("records nothing while the instance is not signed in", async () => {
    const { recorder, queued } = setup(false);
    recorder.recordTurn(facts());
    await recorder.flush();
    expect(queued).toEqual([]);
  });

  it("never throws into the turn when queuing fails", async () => {
    const recorder = new UsageRecorder({
      outbox: {
        enqueue: async () => {
          throw new Error("disk full");
        },
      },
      attribution: { forTurn: async () => ({ kind: "chat", appId: null }) },
      isReporting: () => true,
    });
    expect(() => recorder.recordTurn(facts())).not.toThrow();
    await recorder.flush();
  });
});
