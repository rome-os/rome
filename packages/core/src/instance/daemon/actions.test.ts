import { describe, expect, it } from "@rstest/core";
import { parseDaemonActionRequest } from "./actions.js";

describe("parseDaemonActionRequest", () => {
  it("accepts restart_rome with a thread id", () => {
    expect(parseDaemonActionRequest({ action: "restart_rome", threadId: "sess-1" })).toEqual({
      action: "restart_rome",
      threadId: "sess-1",
    });
  });

  it("rejects restart_rome without a thread id", () => {
    expect(parseDaemonActionRequest({ action: "restart_rome" })).toBeNull();
    expect(parseDaemonActionRequest({ action: "restart_rome", threadId: "   " })).toBeNull();
  });

  it("rejects unknown action names", () => {
    expect(parseDaemonActionRequest({ action: "rebuild_frontend" })).toBeNull();
    expect(parseDaemonActionRequest({ action: "rebuild_web_dashboard" })).toBeNull();
    expect(parseDaemonActionRequest({ action: "restart_internal_api", threadId: "x" })).toBeNull();
  });
});
