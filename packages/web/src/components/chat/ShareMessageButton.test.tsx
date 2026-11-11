// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import "@/i18n";
import { shareMessage } from "@/lib/chat-api";
import { ConciergeMessageMeta } from "./ConciergeMessageMeta";
import { MessageSharingContext, ShareMessageButton } from "./ShareMessageButton";
import { TurnActions } from "./TurnActions";

rs.mock("sonner", () => ({
  toast: Object.assign(rs.fn(), { success: rs.fn(), error: rs.fn() }),
}));
rs.mock("@/lib/chat-api", () => ({ shareMessage: rs.fn() }));
rs.mock("./TurnFeedbackButtons", () => ({ TurnFeedbackButtons: () => null }));
rs.mock("./TurnBranchButton", () => ({ TurnBranchButton: () => null }));

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
  rs.unstubAllGlobals();
});

const reply = {
  messageId: "m-1",
  sessionId: "topic-1",
  author: "agent" as const,
  text: "Day one",
};

const live = (node: ReactNode) =>
  render(<MessageSharingContext.Provider value>{node}</MessageSharingContext.Provider>);

describe("Share on a message", () => {
  it("shares that one message and copies its link", async () => {
    const writeText = rs.fn().mockResolvedValue(undefined);
    rs.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    rs.mocked(shareMessage).mockResolvedValue({ id: "tok", url: "/share/tok", title: "Day one" });

    live(<ShareMessageButton sessionId="topic-1" messageId="m-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Link copied"));
    expect(shareMessage).toHaveBeenCalledWith("topic-1", "m-1");
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/tok`);
  });

  it("says so when the link can't be made", async () => {
    rs.mocked(shareMessage).mockRejectedValue(new Error("nope"));
    live(<ShareMessageButton sessionId="topic-1" messageId="m-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not create the link."));
  });

  it("is offered on a Concierge bubble and under a common chat's answer", () => {
    live(
      <>
        <ConciergeMessageMeta copyText="Day one" createdAt="" feedbackTurn={null} reply={reply} />
        <TurnActions copyText="Day one" feedbackTurn={null} showBranch={false} reply={reply} />
      </>,
    );
    expect(screen.getAllByRole("button", { name: "Share" })).toHaveLength(2);
  });

  it("is not offered on a surface that does not turn sharing on, such as a shared chat", () => {
    render(
      <ConciergeMessageMeta copyText="Day one" createdAt="" feedbackTurn={null} reply={reply} />,
    );
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });
});
