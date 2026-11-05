import { describe, expect, it } from "@rstest/core";
import { CatchUpBuffer, type HeardMessage } from "./catch-up-buffer.js";

// What these pin: a heard message waits until its wake is decided, a prompt
// is never caught up on, catching up lets a message go, and each session
// keeps its own.

function heard(id: number, platformMessageId = `m${-id}`): HeardMessage {
  return { id, platformMessageId, senderName: "Alice", text: `hi ${-id}`, at: new Date(0) };
}

describe("CatchUpBuffer", () => {
  it("holds a message out of catch-up until its wake is decided", () => {
    const buffer = new CatchUpBuffer();
    buffer.heard("s1", heard(-1));
    expect(buffer.unseen("s1")).toEqual([]);
    buffer.decided(-1);
    expect(buffer.unseen("s1").map((line) => line.text)).toEqual(["hi 1"]);
  });

  it("never hands over a message a turn took as its prompt", () => {
    const buffer = new CatchUpBuffer();
    buffer.heard("s1", heard(-1));
    buffer.heard("s1", heard(-2));
    buffer.decided(-1);
    buffer.prompted("s1", "m2");
    buffer.decided(-2);
    expect(buffer.unseen("s1").map((line) => line.id)).toEqual([-1]);
  });

  it("lets a message go once a turn caught up on it", () => {
    const buffer = new CatchUpBuffer();
    buffer.heard("s1", heard(-1));
    buffer.decided(-1);
    buffer.seen([-1], "s1");
    expect(buffer.unseen("s1")).toEqual([]);
  });

  it("keeps each session's messages apart", () => {
    const buffer = new CatchUpBuffer();
    buffer.heard("s1", heard(-1));
    buffer.heard("s2", heard(-2));
    buffer.decided(-1);
    buffer.decided(-2);
    buffer.seen([-1], "s1");
    expect(buffer.unseen("s1")).toEqual([]);
    expect(buffer.unseen("s2").map((line) => line.id)).toEqual([-2]);
  });
});
