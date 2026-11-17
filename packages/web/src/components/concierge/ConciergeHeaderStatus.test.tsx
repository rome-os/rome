// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { ConciergeHeaderStatus } from "./ConciergeHeaderStatus";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

const mascot = (container: HTMLElement) => container.querySelector<SVGElement>(".rome-mascot")!;

describe("ConciergeHeaderStatus", () => {
  it("shows the name alone and a still mascot when idle, with the status read but not drawn", () => {
    const { container } = render(<ConciergeHeaderStatus name="Milo" activity={{ kind: "idle" }} />);
    expect(screen.getByText("Milo")).toBeTruthy();
    const capsule = container.querySelector<HTMLElement>("[data-concierge-header-activity]")!;
    expect(capsule.className).toContain("sr-only");
    expect(capsule.getAttribute("aria-live")).toBe("polite");
    expect(capsule.textContent).toBe("Idle");
    expect(mascot(container).hasAttribute("data-alive")).toBe(false);
  });

  it("puts the name in its own tag under the mascot, and the status in a capsule below it", () => {
    const { container } = render(
      <ConciergeHeaderStatus
        name="Yo"
        activity={{ kind: "tasks", title: "Summarise every meeting this week", more: 0 }}
      />,
    );
    const tag = container.querySelector<HTMLElement>("[data-concierge-header-name]")!;
    const capsule = container.querySelector<HTMLElement>("[data-concierge-header-activity]")!;
    expect(tag.textContent).toBe("Yo");
    expect(tag.contains(capsule)).toBe(false);
    // The tag sits in the column under the mascot; the status spans the header.
    expect(tag.className).toContain("row-start-2");
    expect(tag.className).toContain("col-start-2");
    expect(capsule.className).toContain("row-start-3");
    expect(capsule.className).toContain("col-span-3");
    expect(capsule.className).not.toContain("sr-only");
    // A long name ends in an ellipsis rather than widening the tag without end.
    expect(tag.querySelector("span")!.className).toEqual(expect.stringContaining("truncate"));
  });

  it("shows its menu from the badge, or from the name tag without a badge, and opens nothing itself", () => {
    const opened: string[] = [];
    const menu = {
      items: [{ key: "tasks", icon: null, label: "Tasks", run: () => opened.push("tasks") }],
    };
    const { container, rerender } = render(
      <ConciergeHeaderStatus name="Milo" activity={{ kind: "idle" }} menu={menu} />,
    );
    const badge = screen.getByRole("button", { name: "Chat menu" });
    expect(badge.hasAttribute("data-concierge-header-badge")).toBe(true);
    // Only one trigger: the name tag stays a plain box beside the badge.
    expect(container.querySelector("[data-concierge-header-name]")?.tagName).toBe("DIV");
    fireEvent.click(badge);
    expect(opened).toEqual([]);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Tasks"]);

    rerender(
      <ConciergeHeaderStatus name="Milo" activity={{ kind: "idle" }} badge={false} menu={menu} />,
    );
    expect(
      screen.getByRole("button", { name: "Chat menu" }).hasAttribute("data-concierge-header-name"),
    ).toBe(true);
  });

  it("lifts the name tag and the status a row when the badge is left out", () => {
    const { container } = render(
      <ConciergeHeaderStatus name="Milo" activity={{ kind: "working" }} badge={false} />,
    );
    expect(container.querySelector("[data-concierge-header-badge]")).toBeNull();
    expect(container.querySelector("[data-concierge-header-name]")!.className).toContain(
      "row-start-1",
    );
    expect(container.querySelector("[data-concierge-header-activity]")!.className).toContain(
      "row-start-2",
    );
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
    expect(
      screen.getByText("Starting a task").closest("[aria-live]")?.getAttribute("aria-live"),
    ).toBe("polite");
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
      const span = container.querySelector<HTMLElement>("[aria-live] > span")!;
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

describe("ConciergeHeaderStatus quick menu", () => {
  function renderWithMenu(caption?: string) {
    const opened: string[] = [];
    const item = (key: string, label: string) => ({
      key,
      icon: null,
      label,
      run: () => opened.push(key),
    });
    const { container } = render(
      <ConciergeHeaderStatus
        name="Yo"
        activity={{ kind: "idle" }}
        menu={{ items: [item("tasks", "Tasks"), item("outputs", "Outputs")], caption }}
      />,
    );
    const badge = container.querySelector<HTMLElement>("[data-concierge-header-badge]")!;
    return { opened, badge };
  }
  const items = () => screen.queryAllByRole("menuitem").map((item) => item.textContent);

  it("shows its items on hover, with no counts, and runs the one chosen", () => {
    const { opened, badge } = renderWithMenu();
    expect(items()).toEqual([]);
    fireEvent.pointerEnter(badge, { pointerType: "mouse" });
    expect(items()).toEqual(["Tasks", "Outputs"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Outputs" }));
    expect(opened).toEqual(["outputs"]);
    expect(items()).toEqual([]);
  });

  it("shows the menu on a click or a tap of the badge, and opens no tab from it", () => {
    const { opened, badge } = renderWithMenu();
    fireEvent.click(badge);
    expect(items()).toEqual(["Tasks", "Outputs"]);
    expect(opened).toEqual([]);
  });

  it("names the model that answered last at its foot, as text only", () => {
    renderWithMenu("Opus 5.5");
    fireEvent.click(screen.getByRole("button", { name: "Chat menu" }));
    const caption = document.querySelector("[data-concierge-menu-caption]");
    expect(caption?.textContent).toBe("Opus 5.5");
    expect(caption?.querySelector("button, a")).toBeNull();
  });

  it("moves focus into the menu on Arrow Down, and between its items", async () => {
    const { badge } = renderWithMenu();
    badge.focus();
    fireEvent.keyDown(badge, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Tasks"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Outputs");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Tasks");
  });
});
