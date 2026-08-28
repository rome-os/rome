import { describe, expect, it } from "@rstest/core";
import { BUILTIN_TOOL_APPS, DISCOVERY_SHIM_TOOLS, TOOL_TO_BUILTIN } from "./builtin-tool-apps.js";

describe("builtin trace app mapping", () => {
  it("maps Codex image generation events to the image-generation app", () => {
    expect(BUILTIN_TOOL_APPS.image).toEqual({
      id: "image-generation",
      name: "Image Generation",
      iconUrl: "/builtin-icons/image.svg",
    });
    expect(TOOL_TO_BUILTIN.ImageGeneration).toBe("image");
    expect(TOOL_TO_BUILTIN.image_generation).toBe("image");
    expect(TOOL_TO_BUILTIN.image_generation_call).toBe("image");
    expect(TOOL_TO_BUILTIN.image_gen).toBe("image");
  });

  it("treats current MCP discovery shims as Rome-owned history entries", () => {
    expect([...DISCOVERY_SHIM_TOOLS].sort()).toEqual([
      "describe",
      "list",
      "list_actions",
      "list_skills",
      "read_action",
      "read_skill",
      "search",
      "search_actions",
      "search_skills",
    ]);
  });
});
