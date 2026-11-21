import { describe, expect, it } from "@rstest/core";
import {
  parseComputerUseArgs,
  parseComputerUseObservation,
  parseComputerUseReceipt,
  sanitizeComputerUseArgs,
} from "./protocol.js";

const act = (action: Record<string, unknown>, ref?: string) => ({
  sessionId: "session",
  actionId: "action",
  observationId: "observation",
  stateVersion: 1,
  ...(ref === undefined ? {} : { ref }),
  action,
});

describe("background computer-use protocol", () => {
  it("accepts navigation only for a referenced single primary click", () => {
    const click = { ...act({ type: "click" }, "source"), navigation: true };
    expect(parseComputerUseArgs("computer.act", click)).toEqual(click);
    for (const input of [
      { ...click, ref: undefined },
      { ...click, action: { type: "press" } },
      { ...click, action: { type: "click", button: "right" } },
      { ...click, action: { type: "click", clickCount: 2 } },
      { ...click, navigation: "true" },
    ])
      expect(() => parseComputerUseArgs("computer.act", input)).toThrow();
  });

  it("requires an explicit window without accepting raw process identifiers", () => {
    expect(() => parseComputerUseArgs("computer.bind", {})).toThrow(
      expect.objectContaining({ code: "window_selection_required" }),
    );
    expect(() => parseComputerUseArgs("computer.bind", { pid: 1 })).toThrow(
      expect.objectContaining({ code: "invalid_args" }),
    );
    expect(parseComputerUseArgs("computer.bind", { windowRef: "window" })).toEqual({
      windowRef: "window",
    });
  });

  it("accepts full reset and base versions while rejecting malformed observation requests", () => {
    expect(
      parseComputerUseArgs("computer.observe", {
        sessionId: "session",
        full: true,
        baseVersion: 0,
      }),
    ).toMatchObject({ full: true, baseVersion: 0 });
    for (const value of [
      { full: 1 },
      { baseVersion: -1 },
      { baseVersion: 1.5 },
      { baseVersion: Infinity },
    ])
      expect(() =>
        parseComputerUseArgs("computer.observe", { sessionId: "session", ...value }),
      ).toThrow();
  });

  it("only accepts bounded integer window regions and a boolean enumeration direction", () => {
    const region = { x: 16383, y: 0, width: 1, height: 16384, fromEnd: true };
    const parse = (region: unknown) =>
      parseComputerUseArgs("computer.observe", { sessionId: "session", region });
    expect(parse(region).region).toEqual(region);
    for (const invalid of [
      null,
      { ...region, x: 16384 },
      { ...region, y: 0.5 },
      { ...region, width: 0 },
      { ...region, height: Infinity },
      { ...region, fromEnd: "true" },
      { ...region, screen: true },
    ])
      expect(() => parse(invalid)).toThrow(expect.objectContaining({ code: "invalid_args" }));
  });

  it("accepts element-targeted clicks and scrolling without weakening coordinate pairs", () => {
    for (const action of [{ type: "click" }, { type: "scroll", deltaY: 20 }]) {
      expect(parseComputerUseArgs("computer.act", act(action, "element"))).toHaveProperty(
        "ref",
        "element",
      );
      expect(() => parseComputerUseArgs("computer.act", act(action))).toThrow();
      for (const invalid of [{ x: 1 }, { y: 1 }, { x: NaN, y: 1 }, { x: 1, y: -1 }])
        expect(() =>
          parseComputerUseArgs("computer.act", act({ ...action, ...invalid }, "element")),
        ).toThrow();
      expect(
        parseComputerUseArgs("computer.act", act({ ...action, x: 0, y: 16384 })),
      ).toHaveProperty("action.x", 0);
    }
    expect(() => parseComputerUseArgs("computer.act", act({ type: "move" }, "element"))).toThrow();
  });

  it("gives a usable scroll example when a caller guesses the fields or exceeds the delta limit", () => {
    for (const action of [
      { type: "scroll", dx: 0, dy: -3000 },
      { type: "scroll", deltaX: 0, deltaY: 3000 },
      { type: "scroll", direction: "down", amount: 10 },
    ]) {
      expect(() => parseComputerUseArgs("computer.act", act(action, "element"))).toThrow(
        expect.objectContaining({
          code: "invalid_args",
          message: expect.stringContaining("-2000 to 2000"),
        }),
      );
    }
    const valid = act({ type: "scroll", deltaY: -480 }, "element");
    expect(parseComputerUseArgs("computer.act", valid)).toEqual(valid);
  });

  it("bounds semantic text and raw advertised AX action names", () => {
    const selection = {
      type: "selectText",
      text: "你好",
      prefix: "",
      suffix: "after",
      selectionType: "cursor_after",
    };
    expect(parseComputerUseArgs("computer.act", act(selection, "element"))).toHaveProperty(
      "action",
      selection,
    );
    for (const action of [selection, { type: "performAction", action: "AXShowMenu" }])
      expect(() => parseComputerUseArgs("computer.act", act(action))).toThrow();
    for (const patch of [
      { text: "" },
      { text: "a\0b" },
      { text: "😀".repeat(2049) },
      { prefix: "\0" },
      { suffix: 1 },
      { selectionType: "guess" },
    ])
      expect(() =>
        parseComputerUseArgs("computer.act", act({ ...selection, ...patch }, "element")),
      ).toThrow();
    for (const name of ["", "a\0b", "x".repeat(129)])
      expect(() =>
        parseComputerUseArgs(
          "computer.act",
          act({ type: "performAction", action: name }, "element"),
        ),
      ).toThrow();
    expect(
      parseComputerUseArgs(
        "computer.act",
        act({ type: "setValue", value: "😀".repeat(8192) }, "element"),
      ),
    ).toHaveProperty("action.value");
    expect(() =>
      parseComputerUseArgs(
        "computer.act",
        act({ type: "setValue", value: "😀".repeat(8193) }, "element"),
      ),
    ).toThrow();
    for (const invalid of [
      { type: "drag", x: 1, y: 1, toX: 2, toY: 2, durationMs: 0 },
      { type: "type", text: "a\0b" },
      { type: "key", key: "A", modifiers: ["command", "command"] },
      { type: "scroll", x: 0, y: 0, deltaY: 0.1 },
      { type: "press" },
    ])
      expect(() => parseComputerUseArgs("computer.act", act(invalid))).toThrow();
  });

  it("never includes input text or targeting contents in ordinary audit fields", () => {
    expect(
      sanitizeComputerUseArgs("computer.act", {
        sessionId: "session",
        actionId: "action",
        ref: "private ref",
        screenshot: "private image",
        action: { type: "setValue", value: "secret" },
      }),
    ).toEqual({
      action: "computer.act",
      sessionId: "session",
      actionId: "action",
      operation: "setValue",
      valueBytes: 6,
    });
    for (const action of [
      {
        type: "selectText",
        text: "private text",
        prefix: "private prefix",
        suffix: "private suffix",
      },
      { type: "performAction", action: "private action" },
    ]) {
      const audit = sanitizeComputerUseArgs("computer.act", act(action, "private ref"));
      expect(JSON.stringify(audit)).not.toContain("private");
      expect(audit.operation).toBe(action.type);
    }
  });

  it("rejects duplicate element identities even on legacy full observations", () => {
    expect(() =>
      parseComputerUseObservation(
        {
          sessionId: "s",
          observationId: "o",
          stateVersion: 0,
          complete: true,
          validity: { observedAt: 1, expiresAt: 16, maxAgeSeconds: 15, clock: "remote" },
          elements: [{ ref: "same" }, { ref: "same" }],
        },
        "s",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_helper_response" }));
  });

  it("requires receipts to belong to the requested session and action", () => {
    const stop = { sessionId: "session", status: "cancelled", effectVerified: false };
    const action = { ...stop, actionId: "action", status: "dispatched_unverified" };
    expect(parseComputerUseReceipt(stop, "session")).toBe(stop);
    expect(parseComputerUseReceipt(action, "session", "action")).toBe(action);
    for (const value of [
      stop,
      { ...action, sessionId: "other" },
      { ...action, actionId: "other" },
      { ...action, status: 1 },
      { ...action, effectVerified: "false" },
    ])
      expect(() => parseComputerUseReceipt(value, "session", "action")).toThrow(
        expect.objectContaining({ code: "invalid_computer_response" }),
      );
  });
});
