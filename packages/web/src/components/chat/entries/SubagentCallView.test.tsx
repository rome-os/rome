// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "@rstest/core";
import { SubagentCallView } from "./SubagentCallView";

afterEach(cleanup);

describe("SubagentCallView", () => {
  it("renders one dedicated Child execution row and links to its session", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SubagentCallView
          agentName="planning"
          input={{ prompt: "Inspect the repository" }}
          sessionId="child-session"
          turnId="child-turn"
          status="completed"
          output={{ result: "done" }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("planning")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();

    await user.click(screen.getByRole("button"));

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/sessions/child-session");
    expect(screen.getByText("child-session / child-turn")).toBeTruthy();
  });
});
