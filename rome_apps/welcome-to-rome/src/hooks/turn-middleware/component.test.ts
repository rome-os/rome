import { describe, expect, it } from "@rstest/core";
import type { AgentMessage } from "@rome-os/app-runtime";
import { emitHandoff } from "./component.js";

describe("emitHandoff", () => {
  it("emits the handoff result webchat turns into a child session and its seed", () => {
    const events: AgentMessage[] = [];

    emitHandoff((event) => events.push(event), {
      agentName: "core:main",
      agentLabel: "Spark",
      brief: "Build me a launch tracker.",
    });

    expect(events).toHaveLength(2);
    const [use, result] = events;
    expect(use).toMatchObject({ type: "tool_use", tool: "welcome_handoff" });
    expect(result).toMatchObject({ type: "tool_result", tool: "welcome_handoff" });
    if (use?.type !== "tool_use" || result?.type !== "tool_result") return;
    expect(result.toolUseId).toBe(use.id);
    const [block] = result.output as Array<{ type: string; text: string }>;
    // The host mints the child for `agentName` and the dashboard seeds it with
    // `payload.summary`, labelled `payload.agentLabel`.
    expect(JSON.parse(block?.text ?? "")).toEqual({
      handoff: true,
      appId: "welcome-to-rome",
      agentName: "core:main",
      payload: { summary: "Build me a launch tracker.", agentLabel: "Spark" },
    });
  });
});
