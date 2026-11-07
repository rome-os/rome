import { describe, expect, it } from "@rstest/core";
import { anthropicStop } from "./stop.js";

describe("anthropicStop", () => {
  it("maps the API stop reason", () => {
    expect(anthropicStop({ subtype: "success", stop_reason: "end_turn" }, false)).toEqual({
      reason: "completed",
      raw: "end_turn",
    });
    expect(anthropicStop({ subtype: "success", stop_reason: "stop_sequence" }, false).reason).toBe(
      "completed",
    );
    expect(anthropicStop({ subtype: "success", stop_reason: "max_tokens" }, false).reason).toBe(
      "max_tokens",
    );
    expect(
      anthropicStop({ subtype: "success", stop_reason: "model_context_window_exceeded" }, false)
        .reason,
    ).toBe("max_tokens");
    expect(anthropicStop({ subtype: "success", stop_reason: "refusal" }, false).reason).toBe(
      "refusal",
    );
  });

  it("reports an unknown stop reason as other and keeps the raw value", () => {
    expect(anthropicStop({ subtype: "success", stop_reason: "pause_turn" }, false)).toEqual({
      reason: "other",
      raw: "pause_turn",
    });
  });

  it("reports an abort as interrupted", () => {
    expect(anthropicStop({ subtype: "success", stop_reason: "end_turn" }, true).reason).toBe(
      "interrupted",
    );
    expect(
      anthropicStop(
        { subtype: "success", stop_reason: null, terminal_reason: "aborted_streaming" },
        false,
      ),
    ).toEqual({ reason: "interrupted", raw: "aborted_streaming" });
    expect(
      anthropicStop(
        { subtype: "success", stop_reason: null, terminal_reason: "aborted_tools" },
        false,
      ).reason,
    ).toBe("interrupted");
  });

  it("reports an error result, or a success flagged is_error, as error", () => {
    expect(
      anthropicStop(
        {
          subtype: "error_during_execution",
          stop_reason: null,
          terminal_reason: "prompt_too_long",
        },
        false,
      ),
    ).toEqual({ reason: "error", raw: "prompt_too_long" });
    expect(
      anthropicStop({ subtype: "success", stop_reason: "end_turn", is_error: true }, false).reason,
    ).toBe("error");
    expect(anthropicStop({ subtype: "error_max_turns", stop_reason: null }, false)).toEqual({
      reason: "error",
      raw: "error_max_turns",
    });
  });

  it("explains an error with the loop's reason, not the last model stop reason", () => {
    // Observed on SDK 0.3.281: a max-turns error still carries the last
    // assistant message's `stop_reason: "tool_use"`.
    expect(
      anthropicStop(
        { subtype: "error_max_turns", stop_reason: "tool_use", terminal_reason: "max_turns" },
        false,
      ),
    ).toEqual({ reason: "error", raw: "max_turns" });
    expect(
      anthropicStop(
        {
          subtype: "success",
          is_error: true,
          stop_reason: "end_turn",
          terminal_reason: "api_error",
        },
        false,
      ),
    ).toEqual({ reason: "error", raw: "api_error" });
    expect(
      anthropicStop({ subtype: "success", is_error: true, stop_reason: "end_turn" }, false),
    ).toEqual({ reason: "error", raw: "success" });
  });

  it("falls back to the loop outcome when the model sent no stop reason", () => {
    expect(
      anthropicStop({ subtype: "success", stop_reason: null, terminal_reason: "completed" }, false),
    ).toEqual({ reason: "completed", raw: "completed" });
    expect(anthropicStop({ subtype: "success", stop_reason: null }, false)).toEqual({
      reason: "completed",
      raw: "success",
    });
    expect(
      anthropicStop(
        { subtype: "success", stop_reason: null, terminal_reason: "hook_stopped" },
        false,
      ),
    ).toEqual({ reason: "other", raw: "hook_stopped" });
  });
});
