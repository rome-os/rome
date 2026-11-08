import { describe, expect, it } from "@rstest/core";
import type { TurnResultEvent } from "@rome-os/app-runtime";
import { type AnswerShape, shapedResult } from "./answer-shape.js";

const accounting = {
  provider: "mock",
  model: "m",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const fits: AnswerShape = { check: () => ({ fits: true }) };
const misfits: AnswerShape = {
  check: () => ({ fits: false, issues: ["/name must be string", "/age required"] }),
};

describe("shapedResult", () => {
  it("serializes a fitting answer as the result's text", () => {
    const result: TurnResultEvent = {
      type: "result",
      content: "prose",
      structuredOutput: { a: 1 },
    };

    expect(shapedResult(result, fits, false)).toEqual({
      type: "result",
      content: '{"a":1}',
      structuredOutput: { a: 1 },
    });
  });

  it("fails a turn that suspended", () => {
    expect(
      shapedResult({ type: "result", content: "", structuredOutput: {}, accounting }, fits, true),
    ).toStrictEqual({
      type: "error",
      error: "Agent cannot suspend a turn while outputSchema is configured",
      accounting,
    });
  });

  it("fails a result with no structured answer", () => {
    expect(shapedResult({ type: "result", content: "prose" }, fits, false)).toMatchObject({
      type: "error",
      error: "Provider completed without structured output for the declared outputSchema",
    });
  });

  it("fails an answer that does not fit, listing every issue", () => {
    expect(
      shapedResult({ type: "result", content: "", structuredOutput: {} }, misfits, false),
    ).toMatchObject({
      type: "error",
      error:
        "Provider returned structured output that failed Rome validation: /name must be string; /age required",
    });
  });

  it("fails an answer that cannot be serialized", () => {
    expect(
      shapedResult({ type: "result", content: "", structuredOutput: 10n }, fits, false),
    ).toMatchObject({
      type: "error",
      error: expect.stringContaining("Provider returned non-serializable structured output"),
    });
  });
});
