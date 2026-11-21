import { describe, expect, it } from "@rstest/core";
import type { UsageEvent } from "./events.js";
import type { TurnUsageFacts } from "../agent/index.js";
import { UsageRecorder } from "./recorder.js";

const finishedAt = new Date("2026-10-06T12:00:00.000Z");

function facts(overrides: Partial<TurnUsageFacts> = {}): TurnUsageFacts {
  return {
    turnId: "turn-1",
    romeSessionId: "chat-1",
    sessionKind: "conversation",
    agentName: "main",
    status: "completed",
    provider: "openai",
    model: "gpt-6-sol",
    loginKind: "rome_credits",
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

function setup(credential: string | null = "cred-a") {
  const queued: UsageEvent[] = [];
  const credentials: string[] = [];
  const recorder = new UsageRecorder({
    outbox: {
      enqueue: async (event, queuedUnder) => {
        queued.push(event);
        credentials.push(queuedUnder);
      },
    },
    attribution: { forTurn: async () => ({ kind: "chat", appId: null, trigger: "user" }) },
    credential: () => credential,
  });
  return { recorder, queued, credentials };
}

describe("UsageRecorder", () => {
  it("queues one turn event carrying the accounting, login kind, and provider turn id", async () => {
    const { recorder, queued } = setup();
    recorder.recordTurn(facts());
    await recorder.flush();
    expect(queued).toEqual([
      {
        type: "turn",
        eventId: "turn-1",
        kind: "chat",
        appId: null,
        trigger: "user",
        status: "completed",
        provider: "openai",
        model: "gpt-6-sol",
        loginKind: "rome_credits",
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
        loginKind: undefined,
        providerTurnId: undefined,
      }),
    );
    await recorder.flush();
    expect(queued[0]).toMatchObject({
      status: "error",
      provider: "openai",
      model: "gpt-6-sol",
      providerTurnId: null,
      inputTokens: 0,
      estimatedCostMicros: null,
    });
    expect(JSON.parse(JSON.stringify(queued[0]))).not.toHaveProperty("loginKind");
  });

  it("queues the turn under the credential current when it ended", async () => {
    const { recorder, credentials } = setup("cred-a");
    recorder.recordTurn(facts());
    await recorder.flush();
    expect(credentials).toEqual(["cred-a"]);
  });

  it("records nothing while the instance is not signed in", async () => {
    const { recorder, queued } = setup(null);
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
      attribution: { forTurn: async () => ({ kind: "chat", appId: null, trigger: "user" }) },
      credential: () => "cred-a",
    });
    expect(() => recorder.recordTurn(facts())).not.toThrow();
    expect(() => recorder.recordLogin("password")).not.toThrow();
    await recorder.flush();
  });

  it("queues one event per Rome Cloud listening session, keyed by its session id", async () => {
    const { recorder, queued } = setup();
    recorder.recordTranscription({
      sessionId: "session-1",
      provider: "soniox",
      model: "stt-rt-v6",
      seconds: 12.4,
      status: "ended",
      durationMs: 13_000,
    });
    await recorder.flush();
    expect(queued).toEqual([
      {
        type: "transcription",
        eventId: "session-1",
        kind: "voice_input",
        sessionId: "session-1",
        provider: "soniox",
        model: "stt-rt-v6",
        seconds: 12.4,
        status: "ended",
        durationMs: 13_000,
        occurredAt: expect.any(String),
      },
    ]);
  });

  it("queues one login event per sign-in, carrying the method as its kind", async () => {
    const { recorder, queued, credentials } = setup();
    recorder.recordLogin("rome_cloud");
    recorder.recordLogin("password");
    await recorder.flush();
    expect(queued).toEqual([
      {
        type: "login",
        eventId: expect.any(String),
        kind: "rome_cloud",
        occurredAt: expect.any(String),
      },
      {
        type: "login",
        eventId: expect.any(String),
        kind: "password",
        occurredAt: expect.any(String),
      },
    ]);
    expect(queued[0].eventId).not.toBe(queued[1].eventId);
    expect(credentials).toEqual(["cred-a", "cred-a"]);
  });

  it("records no login while the instance is not signed in", async () => {
    const { recorder, queued } = setup(null);
    recorder.recordLogin("password");
    await recorder.flush();
    expect(queued).toEqual([]);
  });
});
