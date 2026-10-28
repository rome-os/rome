import type { AgentMessage } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import { emitAskQuestion, emitComponent, emitConnectAi } from "./component.js";

/** The card payload a tool_result carries, as core reads it back. */
function cardPayload(emitted: AgentMessage[]): Record<string, unknown> {
  const result = emitted.find((e) => e.type === "tool_result");
  if (!result || result.type !== "tool_result") throw new Error("no tool_result emitted");
  const output = result.output as Array<{ type: string; text: string }>;
  return JSON.parse(output[0].text) as Record<string, unknown>;
}

describe("welcome-to-rome cards", () => {
  it("marks a card the composer must stay closed for, and only then", () => {
    const required: AgentMessage[] = [];
    emitComponent(
      (e) => required.push(e),
      "name-card",
      { guardianName: "Alex" },
      {
        requiresCard: true,
      },
    );
    expect(cardPayload(required).render).toMatchObject({
      kind: "inline",
      componentId: "name-card",
      requiresCard: true,
    });

    const open: AgentMessage[] = [];
    emitComponent((e) => open.push(e), "idea-picker", { ideas: [] });
    expect(cardPayload(open).render).not.toHaveProperty("requiresCard");
  });

  it("keeps the connect-AI card a host built-in while marking it required", () => {
    const emitted: AgentMessage[] = [];
    emitConnectAi((e) => emitted.push(e), { requiresCard: true });
    expect(cardPayload(emitted)).toMatchObject({
      appId: "core",
      render: { componentId: "ai-tools-card", builtin: true, requiresCard: true },
    });
  });

  it("leaves the question card open to a typed answer", () => {
    const emitted: AgentMessage[] = [];
    emitAskQuestion((e) => emitted.push(e), [{ id: "q", question: "Why?", type: "text" }]);
    expect(cardPayload(emitted).render).not.toHaveProperty("requiresCard");
  });
});
