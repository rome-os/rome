import { describe, expect, it } from "@rstest/core";
import { classifyCodexErrorInfo } from "./codex-error-info.js";

describe("classifyCodexErrorInfo", () => {
  it("maps unit variants", () => {
    expect(classifyCodexErrorInfo({ codexErrorInfo: "contextWindowExceeded" })).toEqual({
      code: "context_window_exceeded",
    });
    expect(classifyCodexErrorInfo({ codexErrorInfo: "badRequest" })).toEqual({
      code: "invalid_request",
    });
    expect(classifyCodexErrorInfo({ codexErrorInfo: "serverOverloaded" })).toEqual({
      code: "transient",
    });
    expect(classifyCodexErrorInfo({ codexErrorInfo: "rateLimitExceeded" })).toEqual({
      code: "transient",
    });
  });

  it("maps struct variants and carries their HTTP status", () => {
    expect(
      classifyCodexErrorInfo({
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      }),
    ).toEqual({ code: "transient", httpStatus: 503 });
    expect(
      classifyCodexErrorInfo({
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      }),
    ).toEqual({ code: "transient" });
  });

  it("leaves unmapped variants unclassified", () => {
    expect(classifyCodexErrorInfo({ codexErrorInfo: "sandboxError" })).toEqual({});
    expect(classifyCodexErrorInfo({ codexErrorInfo: "other" })).toEqual({});
    expect(
      classifyCodexErrorInfo({
        codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
      }),
    ).toEqual({});
  });

  it("tolerates missing or malformed payloads", () => {
    expect(classifyCodexErrorInfo(undefined)).toEqual({});
    expect(classifyCodexErrorInfo("a string")).toEqual({});
    expect(classifyCodexErrorInfo({ message: "no info" })).toEqual({});
    expect(classifyCodexErrorInfo({ codexErrorInfo: { a: 1, b: 2 } })).toEqual({});
  });
});
