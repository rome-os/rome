import { describe, expect, it } from "@rstest/core";
import { sessionOfChat } from "./session-scope.js";

describe("sessionOfChat", () => {
  const chat = { channel: "slack_app", chatId: "C1" };

  it("gives a chat its own session under scope chat", () => {
    expect(sessionOfChat(chat, "chat")).toEqual({ continuityKey: "slack_app:C1" });
  });

  it("gives every chat of an account one shared session under scope account", () => {
    expect(sessionOfChat(chat, "account")).toEqual({
      continuityKey: "slack_app:*",
      audience: "shared",
    });
    expect(sessionOfChat({ channel: "slack_app", chatId: "D9" }, "account")).toEqual(
      sessionOfChat(chat, "account"),
    );
  });
});
