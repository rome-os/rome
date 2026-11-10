// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
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
    expect(screen.getByText("Book the flight · +2")).toBeTruthy();
    expect(mascot(container).hasAttribute("data-alive")).toBe(true);
  });

  it("says the tool the Concierge is in", () => {
    render(<ConciergeHeaderStatus name="Milo" activity={{ kind: "tool", tool: "startingTask" }} />);
    expect(screen.getByText("Starting a task").getAttribute("aria-live")).toBe("polite");
  });

  it("says it waits on the guardian in warning colour, with the mascot still", () => {
    const { container } = render(
      <ConciergeHeaderStatus name="Milo" activity={{ kind: "needsYou" }} />,
    );
    expect(screen.getByText("Waiting for your answer").className).toContain("text-warning-fg");
    expect(mascot(container).hasAttribute("data-alive")).toBe(false);
  });

  // jsdom has no AnimationEvent, so React never hears the squash end there.
  it("squashes the mascot on a press", () => {
    const { container } = render(<ConciergeHeaderStatus name="Milo" activity={{ kind: "idle" }} />);
    expect(mascot(container).hasAttribute("data-poked")).toBe(false);
    fireEvent.pointerDown(mascot(container));
    expect(mascot(container).hasAttribute("data-poked")).toBe(true);
  });
});
