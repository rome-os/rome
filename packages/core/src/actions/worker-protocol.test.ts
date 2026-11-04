import { describe, expect, it } from "@rstest/core";
import { ActionInvocationError, isSendRefused, SendRefused } from "@rome-os/app-runtime";
import { fromWireError, toWireError } from "./worker-protocol.js";

describe("worker error envelope", () => {
  it("rebuilds a refused send as one", () => {
    const err = fromWireError(toWireError(new SendRefused("empty", "nothing to send")));
    expect(isSendRefused(err)).toBe(true);
    expect(err).toMatchObject({ reason: "empty", message: "nothing to send" });
  });

  it("keeps the refusal of a called action that an action let pass up", () => {
    const nested = new ActionInvocationError(
      "send_message",
      "handler_error",
      "whatsapp cannot quote a message",
      "reply_unaddressable",
    );
    expect(toWireError(nested)).toEqual({
      name: "ActionInvocationError",
      message: "whatsapp cannot quote a message",
      refusal: "reply_unaddressable",
    });
  });

  it("carries no refusal for any other failure", () => {
    expect(toWireError(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });
});
