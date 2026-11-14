import { describe, expect, it } from "@rstest/core";
import { assertWidgetAlone, assertWidgetAloneInContent } from "./widget-message.js";

const widget = {
  type: "widget",
  toolUseId: "w",
  appId: "meals",
  text: "t",
  ui: { components: [] },
};
const waiting = { type: "pending_interaction", toolUseId: "q", appId: "core", render: {} };
const text = { type: "text", content: "hi" };

describe("a widget is a message of its own", () => {
  it("lets a widget or a card the agent waits on stand alone", () => {
    expect(() => assertWidgetAlone([widget])).not.toThrow();
    expect(() => assertWidgetAlone([waiting])).not.toThrow();
    expect(() => assertWidgetAlone([text, text])).not.toThrow();
  });

  it("refuses a widget beside any other part", () => {
    expect(() => assertWidgetAlone([widget, text])).toThrow();
    expect(() => assertWidgetAlone([widget, waiting])).toThrow();
    expect(() => assertWidgetAloneInContent(JSON.stringify([text, widget]))).toThrow();
  });

  it("leaves content that is not a list of parts alone", () => {
    expect(() => assertWidgetAloneInContent("a widget, in words")).not.toThrow();
  });
});
