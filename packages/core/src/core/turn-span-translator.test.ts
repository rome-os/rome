import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { AgentMessage } from "../types.js";
import { translateTurnSpans } from "./turn-span-translator.js";

describe("translateTurnSpans tool failure", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    trace.disable();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.forceFlush();
    trace.disable();
    await provider.shutdown();
    exporter.reset();
  });

  function toolSpanIsError(result: AgentMessage): unknown {
    const modelSpan = trace.getTracer("test").startSpan("model.turn");
    translateTurnSpans({
      blocks: [
        {
          block: { type: "tool_use", id: "t1", tool: "Bash", input: { command: "false" } },
          tsMs: 1,
        },
        { block: result, tsMs: 2 },
      ],
      modelSpan,
      turnCtx: context.active(),
      modelTurnStartMs: 0,
      terminalTsMs: 3,
      romeAttrs: {},
    });
    modelSpan.end();
    const toolSpan = exporter.getFinishedSpans().find((span) => span.name !== "model.turn");
    return toolSpan?.attributes["tool.is_error"];
  }

  it("records a Codex command that exited non-zero as failed", () => {
    expect(
      toolSpanIsError({
        type: "tool_result",
        toolUseId: "t1",
        tool: "Bash",
        output: { type: "commandExecution", status: "failed", exitCode: 3 },
        isError: true,
      }),
    ).toBe(true);
  });

  it("follows the flag over an output wrapper that says otherwise", () => {
    expect(
      toolSpanIsError({
        type: "tool_result",
        toolUseId: "t1",
        tool: "Bash",
        output: { content: "ok", isError: true },
        isError: false,
      }),
    ).toBe(false);
  });

  it("still reads Claude's output wrapper when a producer sets no flag", () => {
    expect(
      toolSpanIsError({
        type: "tool_result",
        toolUseId: "t1",
        tool: "Bash",
        output: { content: "Exit code 1", isError: true },
      }),
    ).toBe(true);
  });
});
