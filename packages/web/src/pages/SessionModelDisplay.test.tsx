// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { SessionModelList, SessionModelSummary } from "./SessionModelDisplay";

afterEach(cleanup);

describe("SessionModelDisplay", () => {
  it("shows the latest model and discloses the complete ordered identity set", () => {
    render(
      <SessionModelSummary
        models={[
          { kind: "known", provider: "openai", name: "gpt-5.6-sol" },
          { kind: "known", provider: "anthropic", name: "claude-sonnet-5" },
          { kind: "unknown" },
        ]}
      />,
    );

    expect(screen.getByText("gpt-5.6-sol")).toBeDefined();
    expect(screen.getByText("+2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /3 models used/i }));
    expect(screen.getByText("anthropic / claude-sonnet-5")).toBeDefined();
    expect(screen.getByText("Unknown model")).toBeDefined();
  });

  it("distinguishes a session with no run evidence", () => {
    render(<SessionModelList models={[]} />);
    expect(screen.getByText("No model has been recorded yet.")).toBeDefined();
  });
});
