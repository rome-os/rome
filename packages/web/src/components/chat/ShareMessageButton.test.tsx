// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import "@/i18n";
import { ConciergeMessageMeta } from "./ConciergeMessageMeta";
import { MessageSharingContext } from "./ShareMessageButton";
import { TurnActions } from "./TurnActions";

rs.mock("./TurnFeedbackButtons", () => ({ TurnFeedbackButtons: () => null }));
rs.mock("./TurnBranchButton", () => ({ TurnBranchButton: () => null }));

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
});

const reply = {
  messageId: "m-1",
  sessionId: "topic-1",
  author: "agent" as const,
  text: "Day one",
};

const withSharing = (startShare: (messageId: string) => void, node: ReactNode) =>
  render(
    <MessageSharingContext.Provider value={startShare}>{node}</MessageSharingContext.Provider>,
  );

describe("Share on a message", () => {
  it("starts the chat's share mode for that message, from a Concierge bubble and a common chat's answer", () => {
    const startShare = rs.fn();
    withSharing(
      startShare,
      <>
        <ConciergeMessageMeta copyText="Day one" createdAt="" feedbackTurn={null} reply={reply} />
        <TurnActions copyText="Day one" feedbackTurn={null} showBranch={false} reply={reply} />
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: "Share" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);
    // Each names the message, and the turn the place that draws it knows.
    expect(startShare.mock.calls).toEqual([
      ["m-1", expect.objectContaining({ sessionId: "topic-1" })],
      ["m-1", expect.objectContaining({ sessionId: "topic-1" })],
    ]);
  });

  it("is not offered on a surface without share mode, such as a shared chat", () => {
    render(
      <ConciergeMessageMeta copyText="Day one" createdAt="" feedbackTurn={null} reply={reply} />,
    );
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });
});
