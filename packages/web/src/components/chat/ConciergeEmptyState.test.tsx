// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { ConciergeEmptyState } from "./ConciergeEmptyState";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("ConciergeEmptyState", () => {
  it("invites a request in one line and offers four example messages", () => {
    render(<ConciergeEmptyState onPick={() => {}} />);
    const region = screen.getByRole("region", { name: "Just tell me what you want to get done" });
    // One line of text: no description under it.
    expect(region.querySelector('[data-slot="empty-state-description"]')).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "What's the weather today?",
      "Remind me to stretch in an hour",
      "Summarize my unread email",
      "Build me a simple habit tracker app",
    ]);
  });

  it("hands the picked example's text to onPick", async () => {
    const onPick = rs.fn();
    render(<ConciergeEmptyState onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Summarize my unread email" }));
    expect(onPick).toHaveBeenCalledWith("Summarize my unread email");
  });

  it("offers the examples in the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    const onPick = rs.fn();
    render(<ConciergeEmptyState onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "总结一下我的未读邮件" }));
    expect(onPick).toHaveBeenCalledWith("总结一下我的未读邮件");
  });
});
