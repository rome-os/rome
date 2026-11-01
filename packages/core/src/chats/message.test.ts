import { describe, expect, it } from "@rstest/core";
import { messageToRome, partsText, plainText } from "./message.js";
import { placeIn } from "./place.js";

const place = placeIn({ platform: "telegram", id: "chat-1" });
const said = {
  id: "tg-1",
  place,
  saidBy: { account: { platform: "telegram", id: "alice" } },
  body: { text: "Hello" },
  at: new Date("2026-10-29T01:00:00Z"),
};

describe("messageToRome", () => {
  it("refuses a sender on another platform than the chat", () => {
    expect(() =>
      messageToRome({ ...said, saidBy: { account: { platform: "discord", id: "alice" } } }),
    ).toThrow("A message in a telegram chat cannot be said by a discord account");
  });

  it("refuses a message with no adapter id", () => {
    expect(() => messageToRome({ ...said, id: "" })).toThrow("needs its adapter's id");
  });

  it("answers the message going to Rome", () => {
    expect(messageToRome(said).direction).toBe("toRome");
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

describe("partsText", () => {
  it("reads text parts one per line and leaves out commentary", () => {
    expect(
      partsText([
        { type: "text", content: "thinking aloud", turnPhase: "commentary" },
        { type: "text", content: "first" },
        { type: "text", content: "second" },
      ]),
    ).toBe("first\nsecond");
  });
});
