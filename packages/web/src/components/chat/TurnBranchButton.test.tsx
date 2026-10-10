// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { TurnBranchButton } from "./TurnBranchButton";

const placeChatWidget = rs.fn();
rs.mock("@/pages/free/use-free-cells", () => ({
  placeChatWidget: (...args: unknown[]) => placeChatWidget(...args),
}));
rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const emitSessionsChanged = rs.hoisted(() => rs.fn());
rs.mock("@/lib/session-events", () => ({
  emitSessionsChanged,
}));

afterEach(() => {
  cleanup();
  placeChatWidget.mockClear();
  rs.restoreAllMocks();
});

describe("TurnBranchButton", () => {
  it("quick-sends a suggested prompt and opens the returned Sessions route", async () => {
    const fetchMock = rs
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ sessionId: "branch-session", placement: null }, { status: 201 }),
      );
    render(<TurnBranchButton sessionId="chat-session" turnId="turn-1" />);

    fireEvent.click(screen.getByRole("button", { name: "message.branch.open" }));
    fireEvent.click(screen.getByRole("button", { name: "message.branch.suggestions.mermaid" }));

    await waitFor(() => {
      expect(placeChatWidget).toHaveBeenCalledWith("branch-session");
    });
    // The sidebar learns about the born-webchat branch at creation.
    expect(emitSessionsChanged).toHaveBeenCalled();
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
        Response.json({ sessionId: "custom-branch-session", placement: null }, { status: 201 }),
      );
    render(<TurnBranchButton sessionId="chat-session" turnId="turn-2" />);

    fireEvent.click(screen.getByRole("button", { name: "message.branch.open" }));
    fireEvent.change(screen.getByPlaceholderText("message.branch.promptPlaceholder"), {
      target: { value: "  Compare the two approaches  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "message.branch.submit" }));

    await waitFor(() => expect(placeChatWidget).toHaveBeenCalledWith("custom-branch-session"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/chat-session/turns/turn-2/forks",
      expect.objectContaining({
        body: JSON.stringify({ prompt: "Compare the two approaches" }),
      }),
    );
  });

  it("explains a turn with no branch point instead of the generic failure", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: "This answer has no branch point", code: "turn_not_branchable" },
        { status: 409 },
      ),
    );
    render(<TurnBranchButton sessionId="chat-session" turnId="turn-3" />);

    fireEvent.click(screen.getByRole("button", { name: "message.branch.open" }));
    fireEvent.click(screen.getByRole("button", { name: "message.branch.suggestions.mermaid" }));

    expect(await screen.findByText("message.branch.notBranchable")).toBeTruthy();
    expect(placeChatWidget).not.toHaveBeenCalled();
    expect(emitSessionsChanged).not.toHaveBeenCalled();
  });

  it("shows the generic failure on other errors", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "Couldn't start side chat from this conversation" }, { status: 409 }),
    );
    render(<TurnBranchButton sessionId="chat-session" turnId="turn-4" />);

    fireEvent.click(screen.getByRole("button", { name: "message.branch.open" }));
    fireEvent.click(screen.getByRole("button", { name: "message.branch.suggestions.mermaid" }));

    expect(await screen.findByText("message.branch.submitFailed")).toBeTruthy();
    expect(placeChatWidget).not.toHaveBeenCalled();
  });
});
