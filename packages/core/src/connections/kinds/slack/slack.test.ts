import { describe, expect, it } from "@rstest/core";
import { decodeSlackText, parseSlackChatId, splitSlackText } from "./slack.js";

describe("slack text", () => {
  it("unwraps mentions, channels, links and entities", () => {
    expect(
      decodeSlackText(
        "<@UBOT> ask <@U2|bob> in <#C1|general> about <https://x.dev|docs> &amp; more",
        "UBOT",
      ),
    ).toBe("ask @bob in #general about docs (https://x.dev) & more");
  });

  it("splits long text without breaking a code point", () => {
    const chunks = splitSlackText("ab😀cd", 3);
    expect(chunks.join("")).toBe("ab😀cd");
    expect(chunks.every((chunk) => chunk.length <= 3)).toBe(true);
  });

  it("reads a thread address back into channel and thread", () => {
    expect(parseSlackChatId("C1:150.0")).toEqual({ channelId: "C1", threadTs: "150.0" });
    expect(parseSlackChatId("D1")).toEqual({ channelId: "D1" });
  });
});
