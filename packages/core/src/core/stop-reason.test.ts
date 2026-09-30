import { describe, expect, it } from "@rstest/core";
import {
  accountingStop,
  anthropicStop,
  codexStop,
  isInterruptedAccounting,
  resolveTurnStop,
  stopFromLegacyReason,
} from "./stop-reason.js";

const accounting = (fields: Record<string, unknown>) => ({
  provider: "anthropic",
  model: "claude",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...fields,
});

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

describe("codexStop", () => {
  it("maps each turn status", () => {
    expect(codexStop("completed")).toEqual({ reason: "completed", raw: "completed" });
    expect(codexStop("interrupted")).toEqual({ reason: "interrupted", raw: "interrupted" });
    expect(codexStop("failed")).toEqual({ reason: "error", raw: "failed" });
    expect(codexStop("inProgress")).toEqual({ reason: "other", raw: "inProgress" });
    expect(codexStop(undefined)).toEqual({ reason: "other" });
  });
});

describe("stopFromLegacyReason", () => {
  it("reads the deprecated string, including Codex's invented end_turn", () => {
    expect(stopFromLegacyReason(undefined)).toBeUndefined();
    expect(stopFromLegacyReason("end_turn")).toEqual({ reason: "completed", raw: "end_turn" });
    expect(stopFromLegacyReason("interrupted")?.reason).toBe("interrupted");
    expect(stopFromLegacyReason("error")?.reason).toBe("error");
    expect(stopFromLegacyReason("max_tokens")?.reason).toBe("max_tokens");
  });
});

describe("accountingStop and isInterruptedAccounting", () => {
  it("prefers stop over the deprecated string", () => {
    const both = accounting({ stop: { reason: "completed" }, stopReason: "interrupted" });
    expect(accountingStop(both)).toEqual({ reason: "completed" });
    expect(isInterruptedAccounting(both)).toBe(false);
  });

  it("honors the deprecated string when stop is absent", () => {
    expect(isInterruptedAccounting(accounting({ stopReason: "interrupted" }))).toBe(true);
    expect(isInterruptedAccounting(accounting({ stop: { reason: "interrupted" } }))).toBe(true);
    expect(isInterruptedAccounting(undefined)).toBe(false);
  });
});

describe("resolveTurnStop", () => {
  it("lets a user interrupt win over the provider's reason", () => {
    expect(
      resolveTurnStop({
        accounting: accounting({ stop: { reason: "completed", raw: "end_turn" } }),
        terminalKind: "result",
        interrupted: true,
      }),
    ).toEqual({ reason: "interrupted", raw: "end_turn" });
  });

  it("reports an error terminal as error even when the model finished", () => {
    expect(
      resolveTurnStop({
        accounting: accounting({ stop: { reason: "completed", raw: "completed" } }),
        terminalKind: "error",
        interrupted: false,
      }),
    ).toEqual({ reason: "error", raw: "completed" });
    expect(
      resolveTurnStop({ accounting: undefined, terminalKind: "error", interrupted: false }),
    ).toEqual({ reason: "error" });
  });

  it("passes through the provider's stop for a result", () => {
    expect(
      resolveTurnStop({
        accounting: accounting({ stop: { reason: "max_tokens", raw: "max_tokens" } }),
        terminalKind: "result",
        interrupted: false,
      }),
    ).toEqual({ reason: "max_tokens", raw: "max_tokens" });
  });

  it("reports a result with no accounting as completed, and no terminal as undefined", () => {
    expect(
      resolveTurnStop({ accounting: undefined, terminalKind: "result", interrupted: false }),
    ).toEqual({ reason: "completed" });
    expect(
      resolveTurnStop({ accounting: undefined, terminalKind: undefined, interrupted: false }),
    ).toBeUndefined();
  });
});
