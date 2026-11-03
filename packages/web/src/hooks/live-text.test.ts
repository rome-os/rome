import { describe, expect, it, rs } from "@rstest/core";
import { createLiveTextSource } from "./live-text";

describe("live text source", () => {
  it("holds the text of the open turn's current block and tells its subscribers", () => {
    const source = createLiveTextSource();
    const listener = rs.fn();
    source.subscribe(listener);
    expect(source.get()).toEqual({ key: "idle", text: "" });

    source.open("turn-1");
    source.set("turn-1", 0, "Hel");
    source.set("turn-1", 0, "Hello");
    expect(source.get()).toEqual({ key: "turn-1:0", text: "Hello" });
    expect(listener).toHaveBeenCalledTimes(3);

    // The same delivery again is not news.
    source.set("turn-1", 0, "Hello");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("moves to a higher block and ignores an earlier one", () => {
    const source = createLiveTextSource();
    source.open("turn-1");
    source.set("turn-1", 1, "second block");
    source.set("turn-1", 0, "stale first block");
    expect(source.get()).toEqual({ key: "turn-1:1", text: "second block" });
  });

  it("ignores text from a turn that is not open, and an end from a stale turn", () => {
    const source = createLiveTextSource();
    source.set("turn-1", 0, "before it started");
    expect(source.get().text).toBe("");

    source.open("turn-1");
    source.open("turn-2");
    source.set("turn-1", 0, "stale reader");
    expect(source.get()).toEqual({ key: "turn-2:0", text: "" });

    source.close("turn-1");
    expect(source.get().key).toBe("turn-2:0");
    source.close("turn-2");
    expect(source.get()).toEqual({ key: "idle", text: "" });
    source.set("turn-2", 0, "after it ended");
    expect(source.get().text).toBe("");
  });

  it("stops telling a subscriber that unsubscribed", () => {
    const source = createLiveTextSource();
    const listener = rs.fn();
    const unsubscribe = source.subscribe(listener);
    source.open("turn-1");
    unsubscribe();
    source.set("turn-1", 0, "text");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
