// @rstest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { COPIED_FEEDBACK_MS, useCopyFeedback } from "./use-copy-feedback";

let feedback: ReturnType<typeof useCopyFeedback>;
function Probe() {
  feedback = useCopyFeedback();
  return <output>{feedback.copiedText ?? ""}</output>;
}

const writeText = rs.fn();

describe("useCopyFeedback", () => {
  beforeEach(() => {
    rs.useFakeTimers();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    cleanup();
    rs.useRealTimers();
  });

  it("shows what was copied for a moment, then clears", async () => {
    render(<Probe />);
    await act(() => feedback.copy("https://a"));
    expect(writeText).toHaveBeenCalledWith("https://a");
    expect(screen.getByRole("status").textContent).toBe("https://a");
    act(() => rs.advanceTimersByTime(COPIED_FEEDBACK_MS));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("restarts the moment on a second copy, so the earlier timer cannot clear it early", async () => {
    render(<Probe />);
    await act(() => feedback.copy("https://a"));
    act(() => rs.advanceTimersByTime(COPIED_FEEDBACK_MS - 100));
    await act(() => feedback.copy("https://b"));
    act(() => rs.advanceTimersByTime(200));
    expect(screen.getByRole("status").textContent).toBe("https://b");
  });

  it("shows nothing and resolves false when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<Probe />);
    let result = true;
    await act(async () => {
      result = await feedback.copy("x");
    });
    expect(result).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("ends the moment on reset", async () => {
    render(<Probe />);
    await act(() => feedback.copy("x"));
    act(() => feedback.reset());
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
