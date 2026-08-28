import { describe, expect, it } from "@rstest/core";
import { resolvePortableToolApp } from "./builtin-apps.js";

describe("resolvePortableToolApp", () => {
  it.each([
    "execute",
    "execute_action",
  ])("resolves %s shims from the action_name app prefix", (tool) => {
    expect(
      resolvePortableToolApp({
        type: "tool_use",
        tool,
        input: { action_name: "workflow-studio_create_workflow" },
      }),
    ).toEqual({
      id: "workflow-studio",
      name: "Workflow Studio",
      iconUrl: "/api/apps/workflow-studio/icon",
    });
  });
});
