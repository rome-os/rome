// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { ConciergeHeaderStatus } from "./ConciergeHeaderStatus";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

const mascot = (container: HTMLElement) => container.querySelector<SVGElement>(".rome-mascot")!;

describe("ConciergeHeaderStatus", () => {
  it("shows the name alone and a still mascot when idle", () => {
    const { container } = render(<ConciergeHeaderStatus name="Milo" activity={{ kind: "idle" }} />);
    expect(screen.getByText("Milo")).toBeTruthy();
    expect(screen.getByText("Idle").className).toContain("sr-only");
    expect(mascot(container).hasAttribute("data-alive")).toBe(false);
  });

  it("says a running task chat's title, and how many more run", () => {
    const { container } = render(
      <ConciergeHeaderStatus
        name="Milo"
        activity={{ kind: "tasks", title: "Book the flight", more: 2 }}
      />,
    );
    expect(screen.getByText("Book the flight +2")).toBeTruthy();
    expect(mascot(container).hasAttribute("data-alive")).toBe(true);
  });

  it("says the tool the Concierge is in", () => {
    render(<ConciergeHeaderStatus name="Milo" activity={{ kind: "tool", tool: "startingTask" }} />);
    expect(screen.getByText("Starting a task").getAttribute("aria-live")).toBe("polite");
  });

  it("says it waits on the guardian in the muted colour of every status, still and unshimmered", () => {
    const { container } = render(
      <ConciergeHeaderStatus name="Milo" activity={{ kind: "needsYou" }} />,
    );
    const line = screen.getByText("Waiting for your answer");
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("warning");
    expect(line.className).not.toContain("shimmer");
    expect(mascot(container).hasAttribute("data-alive")).toBe(false);
  });

  // jsdom has no AnimationEvent, so React never hears the squash end there.
  it("says a lone running task by its title alone", () => {
    render(
      <ConciergeHeaderStatus
        name="Milo"
        activity={{ kind: "tasks", title: "Tokyo time", more: 0 }}
      />,
    );
    expect(screen.getByText("Tokyo time")).toBeTruthy();
  });

  it("uses the same short form in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      const { rerender } = render(
        <ConciergeHeaderStatus
          name="Milo"
          activity={{ kind: "tasks", title: "东京时间", more: 0 }}
        />,
      );
      expect(screen.getByText("东京时间")).toBeTruthy();
      rerender(
        <ConciergeHeaderStatus
          name="Milo"
          activity={{ kind: "tasks", title: "东京时间", more: 2 }}
        />,
      );
      expect(screen.getByText("东京时间 +2")).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("shimmers the status line while work is under way, and only then", () => {
    const line = (activity: ConciergeActivity) => {
      const { container, unmount } = render(
        <ConciergeHeaderStatus name="Milo" activity={activity} />,
      );
      const span = container.querySelector<HTMLElement>("[aria-live]")!;
      const shimmers = span.classList.contains("shimmer");
      unmount();
      return shimmers;
    };
    expect(line({ kind: "working" })).toBe(true);
    expect(line({ kind: "tool", tool: "startingTask" })).toBe(true);
    expect(line({ kind: "tasks", title: "Tokyo time", more: 0 })).toBe(true);
    expect(line({ kind: "needsYou" })).toBe(false);
    expect(line({ kind: "idle" })).toBe(false);
  });

  it("squashes the mascot on a press", () => {
    const { container } = render(<ConciergeHeaderStatus name="Milo" activity={{ kind: "idle" }} />);
    expect(mascot(container).hasAttribute("data-poked")).toBe(false);
    fireEvent.pointerDown(mascot(container));
    expect(mascot(container).hasAttribute("data-poked")).toBe(true);
  });
});
