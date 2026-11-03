// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import "@/i18n";
import type { ChatEntry } from "@/lib/chat-types";
import { renderFlatEntries } from "./render";
import { toolCallDotClass } from "./ToolCallView";

afterEach(cleanup);

function dotClassFor(
  result: Pick<Extract<ChatEntry, { type: "tool_result" }>, "output" | "isError">,
): string | undefined {
  const blocks: ChatEntry[] = [
    { type: "tool_use", id: "use-1", tool: "Bash", input: { command: "ls" } },
    { type: "tool_result", toolUseId: "use-1", tool: "Bash", ...result },
  ];
  const { container } = render(<>{renderFlatEntries(blocks)}</>);
  return container.querySelector("span.rounded-full")?.className;
}

describe("tool step status", () => {
  it("follows the normalized isError flag over the output", () => {
    expect(dotClassFor({ output: { exitCode: 0 }, isError: true })).toContain(
      toolCallDotClass("error"),
    );
    cleanup();
    expect(dotClassFor({ output: { exitCode: 2 }, isError: false })).toContain(
      toolCallDotClass("ok"),
    );
  });

  it("reads the provider's own failure signal on a result recorded before isError", () => {
    expect(dotClassFor({ output: { status: "failed", exitCode: 2 } })).toContain(
      toolCallDotClass("error"),
    );
    cleanup();
    expect(dotClassFor({ output: "fine" })).toContain(toolCallDotClass("ok"));
  });
});
