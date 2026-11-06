import { describe, expect, it } from "@rstest/core";
import { codexToolItemIsError } from "./tool-result-error.js";

describe("codexToolItemIsError", () => {
  it("fails a command on a failed or declined status, or a non-zero exit code", () => {
    expect(
      codexToolItemIsError({ type: "commandExecution", status: "completed", exitCode: 0 }),
    ).toBe(false);
    expect(
      codexToolItemIsError({ type: "commandExecution", status: "completed", exitCode: 2 }),
    ).toBe(true);
    expect(
      codexToolItemIsError({ type: "commandExecution", status: "failed", exitCode: null }),
    ).toBe(true);
    expect(codexToolItemIsError({ type: "commandExecution", status: "declined" })).toBe(true);
  });

  it("fails a file change only on a failed or declined status", () => {
    expect(codexToolItemIsError({ type: "fileChange", status: "completed", changes: [] })).toBe(
      false,
    );
    expect(codexToolItemIsError({ type: "fileChange", status: "declined", changes: [] })).toBe(
      true,
    );
  });

  it("fails an MCP call on a failed status or a populated error", () => {
    expect(codexToolItemIsError({ type: "mcpToolCall", status: "completed", error: null })).toBe(
      false,
    );
    expect(
      codexToolItemIsError({ type: "mcpToolCall", status: "completed", error: { message: "x" } }),
    ).toBe(true);
    expect(codexToolItemIsError({ type: "mcpToolCall", status: "failed" })).toBe(true);
  });

  it("fails a Rome tool call from Rome's own result or codex's success flag", () => {
    expect(codexToolItemIsError({ type: "dynamicToolCall", status: "completed" }, false)).toBe(
      false,
    );
    expect(codexToolItemIsError({ type: "dynamicToolCall", status: "completed" }, true)).toBe(true);
    expect(
      codexToolItemIsError({ type: "dynamicToolCall", status: "completed", success: false }),
    ).toBe(true);
  });

  it("treats a web search as succeeded unless codex reports a failed status", () => {
    expect(codexToolItemIsError({ type: "webSearch", query: "rome" })).toBe(false);
    expect(codexToolItemIsError({ type: "webSearch", status: "failed" })).toBe(true);
  });
});
