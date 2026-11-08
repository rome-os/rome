import { describe, expect, it } from "@rstest/core";
import type { TurnErrorEvent, TurnResultEvent } from "@rome-os/app-runtime";
import { endedTurn } from "./turn-lifecycle.js";

const accounting = {
  provider: "mock",
  model: "m",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

describe("endedTurn", () => {
  it("reports a completed result as final, with its text, structured output and accounting", () => {
    const terminal: TurnResultEvent = {
      type: "result",
      content: "done",
      structuredOutput: { ok: true },
      accounting: { ...accounting, stop: { reason: "completed" } },
    };

    expect(endedTurn({ terminal, stoppedByRome: false }, "mock")).toStrictEqual({
      status: "completed",
      output: {
        text: "done",
        structuredOutput: { ok: true },
        state: "final",
        terminalKind: "result",
        stop: { reason: "completed" },
        stopReason: undefined,
        accounting: { ...accounting, stop: { reason: "completed" } },
      },
    });
  });

  it("reports a result Rome stopped as partial, with `interrupted` as its deprecated reason", () => {
    const terminal: TurnResultEvent = { type: "result", content: "half" };

    expect(endedTurn({ terminal, stoppedByRome: true }, "mock")).toStrictEqual({
      status: "interrupted",
      output: {
        text: "half",
        structuredOutput: undefined,
        state: "partial",
        terminalKind: "result",
        stop: { reason: "interrupted" },
        stopReason: "interrupted",
        accounting: undefined,
      },
    });
  });

  it("keeps the provider's own deprecated reason over Rome's", () => {
    const terminal: TurnResultEvent = {
      type: "result",
      content: "cut",
      accounting: { ...accounting, stopReason: "max_tokens" },
    };

    expect(endedTurn({ terminal, stoppedByRome: true }, "mock").output.stopReason).toBe(
      "max_tokens",
    );
  });

  it("reports an error with its failure last, naming the provider that ran it", () => {
    const terminal: TurnErrorEvent = {
      type: "error",
      error: "quota",
      code: "usage_limit",
      httpStatus: 429,
    };

    const { status, output } = endedTurn({ terminal, stoppedByRome: false }, "openai");

    expect(status).toBe("error");
    expect(output).toStrictEqual({
      text: "",
      state: "none",
      terminalKind: "error",
      stop: { reason: "error" },
      stopReason: undefined,
      error: "quota",
      accounting: undefined,
      failure: { message: "quota", provider: "openai", code: "usage_limit", httpStatus: 429 },
    });
    expect(Object.keys(output).at(-1)).toBe("failure");
  });

  it("reports a turn no terminal event closed as abandoned with no output", () => {
    expect(endedTurn({ stoppedByRome: false }, "mock")).toStrictEqual({
      status: "stopped",
      output: { text: "", state: "none", stopReason: undefined },
    });
  });
});
