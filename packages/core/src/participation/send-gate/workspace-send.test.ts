import { describe, expect, it } from "@rstest/core";
import type { SendRequest } from "./index.js";
import { guardedSend, workspaceSend } from "./index.js";

const gate = workspaceSend((connectionId) => connectionId === "workspace", guardedSend);

function request(connectionId: string, sameChatAsWake: boolean): SendRequest {
  return {
    destination: {
      connectionId,
      chatId: "C1",
      place: "group",
      sameChatAsWake,
      onlyGuardianReads: false,
    },
    recipient: { bondLevel: "other" },
    author: { agentName: "core:concierge" },
  };
}

describe("workspaceSend", () => {
  it("sends a message to a member into any chat of a workspace account", () => {
    expect(gate(request("workspace", true))).toBe("send");
    expect(gate(request("workspace", false))).toBe("send");
  });

  it("leaves any other account to the gate it wraps", () => {
    expect(gate(request("telegram", true))).toBe("check");
  });
});
