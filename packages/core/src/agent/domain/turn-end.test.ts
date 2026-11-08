import { describe, expect, it } from "@rstest/core";
import type {
  AgentAccounting,
  AgentStop,
  TurnErrorEvent,
  TurnResultEvent,
} from "@rome-os/app-runtime";
import { type TurnEnding, turnStatus, turnStop } from "./turn-end.js";

const accounting = (fields: Partial<AgentAccounting>): AgentAccounting => ({
  provider: "anthropic",
  model: "claude",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...fields,
});
const result = (acc?: Partial<AgentAccounting>): TurnResultEvent => ({
  type: "result",
  content: "",
  ...(acc ? { accounting: accounting(acc) } : {}),
});
const error = (acc?: Partial<AgentAccounting>): TurnErrorEvent => ({
  type: "error",
  error: "boom",
  ...(acc ? { accounting: accounting(acc) } : {}),
});

describe("how a turn ends", () => {
  const cases: {
    name: string;
    ending: TurnEnding;
    stop: AgentStop | undefined;
    status: ReturnType<typeof turnStatus>;
  }[] = [
    {
      name: "a result completes the turn and keeps the provider's stop reason",
      ending: {
        terminal: result({ stop: { reason: "max_tokens", raw: "max_tokens" } }),
        stoppedByRome: false,
      },
      stop: { reason: "max_tokens", raw: "max_tokens" },
      status: "completed",
    },
    {
      name: "a result with no accounting completes the turn",
      ending: { terminal: result(), stoppedByRome: false },
      stop: { reason: "completed" },
      status: "completed",
    },
    {
      name: "a result never fails the turn: a provider error under it reads as other",
      ending: {
        terminal: result({ stop: { reason: "error", raw: "api_error" } }),
        stoppedByRome: false,
      },
      stop: { reason: "other", raw: "api_error" },
      status: "completed",
    },
    {
      name: "an error event fails the turn even when the model finished",
      ending: {
        terminal: error({ stop: { reason: "completed", raw: "completed" } }),
        stoppedByRome: false,
      },
      stop: { reason: "error", raw: "completed" },
      status: "error",
    },
    {
      name: "an error event with no accounting fails the turn",
      ending: { terminal: error(), stoppedByRome: false },
      stop: { reason: "error" },
      status: "error",
    },
    {
      name: "a Rome stop decides first, over a result",
      ending: {
        terminal: result({ stop: { reason: "completed", raw: "end_turn" } }),
        stoppedByRome: true,
      },
      stop: { reason: "interrupted", raw: "end_turn" },
      status: "interrupted",
    },
    {
      name: "a Rome stop decides first, over an error event",
      ending: { terminal: error(), stoppedByRome: true },
      stop: { reason: "interrupted" },
      status: "interrupted",
    },
    {
      name: "a Rome stop with no terminal event stops the turn",
      ending: { stoppedByRome: true },
      stop: { reason: "interrupted" },
      status: "interrupted",
    },
    {
      name: "the provider's own stop stops the turn, even under an error event",
      ending: {
        terminal: error({ stop: { reason: "interrupted", raw: "aborted_tools" } }),
        stoppedByRome: false,
      },
      stop: { reason: "interrupted", raw: "aborted_tools" },
      status: "interrupted",
    },
    {
      name: "no stop and no terminal event abandons the turn",
      ending: { stoppedByRome: false },
      stop: undefined,
      status: "stopped",
    },
    {
      name: "stop wins over the deprecated string",
      ending: {
        terminal: result({ stop: { reason: "completed" }, stopReason: "interrupted" }),
        stoppedByRome: false,
      },
      stop: { reason: "completed" },
      status: "completed",
    },
    {
      name: "the deprecated string is read when stop is absent",
      ending: { terminal: result({ stopReason: "interrupted" }), stoppedByRome: false },
      stop: { reason: "interrupted", raw: "interrupted" },
      status: "interrupted",
    },
    {
      name: "the deprecated string reads Codex's end_turn as completed",
      ending: { terminal: result({ stopReason: "end_turn" }), stoppedByRome: false },
      stop: { reason: "completed", raw: "end_turn" },
      status: "completed",
    },
    {
      name: "the deprecated string reads an unknown value as other",
      ending: { terminal: result({ stopReason: "pause_turn" }), stoppedByRome: false },
      stop: { reason: "other", raw: "pause_turn" },
      status: "completed",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(turnStop(c.ending)).toEqual(c.stop);
      expect(turnStatus(c.ending)).toBe(c.status);
    });
  }

  it("reads each deprecated string the adapters wrote", () => {
    const read = (stopReason: string) =>
      turnStop({ terminal: result({ stopReason }), stoppedByRome: false })?.reason;
    expect(read("stop_sequence")).toBe("completed");
    expect(read("max_tokens")).toBe("max_tokens");
    expect(read("model_context_window_exceeded")).toBe("max_tokens");
    expect(read("refusal")).toBe("refusal");
    expect(turnStop({ terminal: error({ stopReason: "error" }), stoppedByRome: false })).toEqual({
      reason: "error",
      raw: "error",
    });
  });
});
