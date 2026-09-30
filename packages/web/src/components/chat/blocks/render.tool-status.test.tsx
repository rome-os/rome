// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import "@/i18n";
import type { StreamBlock } from "@/lib/chat-types";
import { renderFlatBlocks } from "./render";
import { toolStepDotClass } from "./ToolStepBlock";

afterEach(cleanup);

function dotClassFor(result: Partial<StreamBlock>): string | undefined {
  const blocks: StreamBlock[] = [
    { type: "tool_use", id: "use-1", tool: "Bash", input: { command: "ls" } },
    { type: "tool_result", toolUseId: "use-1", tool: "Bash", ...result },
  ];
  const { container } = render(<>{renderFlatBlocks(blocks)}</>);
  return container.querySelector("span.rounded-full")?.className;
}

describe("tool step status", () => {
  it("follows the normalized isError flag over the output", () => {
    expect(dotClassFor({ output: { exitCode: 0 }, isError: true })).toContain(
      toolStepDotClass("error"),
    );
    cleanup();
    expect(dotClassFor({ output: { exitCode: 2 }, isError: false })).toContain(
      toolStepDotClass("ok"),
    );
  });

  it("reads the provider's own failure signal on a result recorded before isError", () => {
    expect(dotClassFor({ output: { status: "failed", exitCode: 2 } })).toContain(
      toolStepDotClass("error"),
    );
    cleanup();
    expect(dotClassFor({ output: "fine" })).toContain(toolStepDotClass("ok"));
  });
});
