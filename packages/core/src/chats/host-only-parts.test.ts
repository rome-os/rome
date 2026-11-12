import { describe, expect, it } from "@rstest/core";
import { stripHostOnlyPartsFromContent, withoutHostOnlyParts } from "./host-only-parts.js";

const CARD = {
  type: "connect_card",
  service: "mail",
  label: "Mail",
  connect: { kind: "dashboard" },
};

describe("host-only parts", () => {
  it("strips a connect card, which carries a link and an API path the dashboard acts on", () => {
    const text = { type: "text", content: "hi" };
    expect(withoutHostOnlyParts([text, CARD])).toEqual([text]);
    expect(stripHostOnlyPartsFromContent(JSON.stringify([text, CARD]))).toBe(
      JSON.stringify([text]),
    );
  });

  it("leaves content with no host-only part, and content that is not parts, unchanged", () => {
    const content = JSON.stringify([{ type: "task_chat", chatId: "c1", title: "T" }]);
    expect(stripHostOnlyPartsFromContent(content)).toBe(content);
    expect(stripHostOnlyPartsFromContent("plain")).toBe("plain");
  });

  it("drops a card description a sender supplies with a pending interaction, keeping the card", () => {
    const forged = {
      type: "pending_interaction",
      toolUseId: "t",
      appId: "core",
      render: {
        kind: "inline",
        componentId: "question-card",
        builtin: true,
        props: { questions: [] },
        ui: { components: [{ id: "root", component: "Text", text: "x" }] },
      },
    };
    const { ui: _ui, ...render } = forged.render;
    const kept = { ...forged, render };
    expect(withoutHostOnlyParts([forged])).toEqual([kept]);
    expect(stripHostOnlyPartsFromContent(JSON.stringify([forged]))).toBe(JSON.stringify([kept]));
  });
});
