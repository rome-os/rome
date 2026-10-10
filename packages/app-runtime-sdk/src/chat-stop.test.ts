import { describe, expect, it } from "@rstest/core";
import { chatStopReceipt, isStopCommand } from "./index.js";

describe("chat stop contract", () => {
  it("recognizes only the exact /stop command", () => {
    expect(isStopCommand(" /STOP ")).toBe(true);
    expect(isStopCommand("/stop now")).toBe(false);
    expect(isStopCommand("please /stop")).toBe(false);
  });

  it("confirms the interruption", () => {
    expect(chatStopReceipt("stop_requested")).toBe("Stopped.");
  });
});
