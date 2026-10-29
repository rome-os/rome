import { describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { messageToRome, plainText } from "./message.js";
import { chatKey, placeIn } from "./place.js";

const place = placeIn(chatKey("telegram", "group-1" as ChatId));
const said = {
  place,
  saidBy: { account: { platform: "telegram", id: "alice" } },
  body: { text: "Hello" },
  platformMessageId: "tg-1",
  at: new Date("2026-10-29T01:00:00Z"),
};

describe("messageToRome", () => {
  it("refuses a sender on another platform than the chat", () => {
    expect(() =>
      messageToRome({ ...said, saidBy: { account: { platform: "discord", id: "alice" } } }),
    ).toThrow("A message in a telegram chat cannot be said by a discord account");
  });

  it("refuses a message with no platform id", () => {
    expect(() => messageToRome({ ...said, platformMessageId: "" })).toThrow(
      "needs the platform's id",
    );
  });
});

describe("plainText", () => {
  it("reads saved attachments as lines after the text, and leaves out unsaved ones", () => {
    expect(
      plainText({
        text: " Look ",
        attachments: [
          { type: "image", fileName: "a.jpg", localPath: "/tmp/a.jpg", caption: "cat" },
          { type: "document", url: "not-saved" },
        ],
      }),
    ).toBe("Look\n\nAttachment 1 (image a.jpg) path: /tmp/a.jpg caption: cat");
  });
});
