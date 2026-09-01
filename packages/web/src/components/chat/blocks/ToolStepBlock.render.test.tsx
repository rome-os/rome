// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import "@/i18n";
import { ToolStepBlock } from "./ToolStepBlock";

afterEach(cleanup);

describe("ToolStepBlock incomplete results", () => {
  it("keeps the input and labels a finished call without a result as unknown", () => {
    render(
      <ToolStepBlock
        tool="Edit"
        input={{ path: "changed.ts" }}
        output={undefined}
        status="running"
        hasResult={false}
      />,
    );
    expect(screen.getByText("Result unknown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("changed.ts").length).toBeGreaterThan(0);
    expect(screen.getByText(/The tool may have made changes/)).toBeTruthy();
  });

  it.each([
    { live: true, hasResult: false },
    { live: false, hasResult: true },
  ])("does not label live or completed calls as unknown: %j", ({ live, hasResult }) => {
    render(
      <ToolStepBlock
        tool="Edit"
        input={{ path: "changed.ts" }}
        output="File changed"
        status={hasResult ? "ok" : "running"}
        hasResult={hasResult}
        live={live}
      />,
    );
    expect(screen.queryByText("Result unknown")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    if (hasResult) expect(screen.getByText("File changed")).toBeTruthy();
  });
});
