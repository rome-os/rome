// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { TurnBranchButton } from "./TurnBranchButton";

const autoPlaceApp = rs.fn();
rs.mock("@/pages/free/use-free-cells", () => ({
  autoPlaceApp: (...args: unknown[]) => autoPlaceApp(...args),
}));
rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  autoPlaceApp.mockClear();
  rs.restoreAllMocks();
});

describe("TurnBranchButton", () => {
  it("quick-sends a suggested prompt and opens the returned Sessions route", async () => {
    const fetchMock = rs
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { placement: { appId: "sessions", route: "branch-session" } },
          { status: 201 },
        ),
      );
    render(<TurnBranchButton sessionId="chat-session" turnId="turn-1" />);

    fireEvent.click(screen.getByRole("button", { name: "message.branch.open" }));
    fireEvent.click(screen.getByRole("button", { name: "message.branch.suggestions.mermaid" }));

    await waitFor(() => {
      expect(autoPlaceApp).toHaveBeenCalledWith("sessions", "branch-session");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/chat-session/turns/turn-1/forks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "message.branch.suggestions.mermaid" }),
      }),
    );
  });

  it("submits a trimmed custom prompt", async () => {
    const fetchMock = rs
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { placement: { appId: "sessions", route: "custom-branch-session" } },
          { status: 201 },
        ),
      );
    render(<TurnBranchButton sessionId="chat-session" turnId="turn-2" />);

    fireEvent.click(screen.getByRole("button", { name: "message.branch.open" }));
    fireEvent.change(screen.getByPlaceholderText("message.branch.promptPlaceholder"), {
      target: { value: "  Compare the two approaches  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "message.branch.submit" }));

    await waitFor(() => expect(autoPlaceApp).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/chat-session/turns/turn-2/forks",
      expect.objectContaining({
        body: JSON.stringify({ prompt: "Compare the two approaches" }),
      }),
    );
  });
});
