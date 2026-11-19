// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { ChatHeaderActions, type HeaderMenu } from "./ChatHeaderActions";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

function renderActions({
  tasks = true,
  needsYou = false,
  caption,
}: {
  tasks?: boolean;
  needsYou?: boolean;
  caption?: string;
} = {}) {
  const ran: string[] = [];
  const item = (key: string, label: string, destructive = false) => ({
    key,
    icon: null,
    label,
    destructive,
    run: () => ran.push(key),
  });
  const menu: HeaderMenu = {
    sections: [
      [item("outputs", "Outputs"), item("routines", "Routines")],
      [item("rename", "Rename"), item("share", "Share chat"), item("delete", "Delete", true)],
    ],
    caption,
  };
  const { container } = render(
    <ChatHeaderActions
      floating
      tasks={tasks ? { needsYou, open: () => ran.push("tasks") } : undefined}
      menu={menu}
    />,
  );
  const more = screen.getByRole("button", { name: "More actions" });
  return { ran, more, container };
}
const items = () => screen.queryAllByRole("menuitem").map((item) => item.textContent);

describe("ChatHeaderActions", () => {
  it("holds Tasks and ⋯ in one capsule, and Tasks opens the task list", () => {
    const { ran, container } = renderActions();
    const capsule = container.querySelector<HTMLElement>("[data-chat-header-actions]")!;
    expect(capsule.className).toContain("rounded-full");
    const buttons = [...capsule.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(buttons).toEqual(["Tasks", "More actions"]);
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(ran).toEqual(["tasks"]);
    expect(items()).toEqual([]);
  });

  it("keeps the needs-you dot on the Tasks button, only while a task needs the guardian", () => {
    renderActions({ needsYou: true });
    const dot = screen.getByRole("img", { name: "A task needs you" });
    expect(dot.closest("button")?.getAttribute("aria-label")).toBe("Tasks");
    cleanup();
    renderActions({ needsYou: false });
    expect(screen.queryByRole("img", { name: "A task needs you" })).toBeNull();
  });

  it("has ⋯ alone in a chat with no task list", () => {
    const { container } = renderActions({ tasks: false });
    expect(screen.queryByRole("button", { name: "Tasks" })).toBeNull();
    expect(container.querySelectorAll("[data-chat-header-actions] button")).toHaveLength(1);
  });

  it("shows the menu on hover, in sections, and runs the item chosen", () => {
    const { ran, more } = renderActions();
    fireEvent.pointerEnter(more, { pointerType: "mouse" });
    const sections = document.querySelectorAll("[data-chat-header-menu-section]");
    expect([...sections].map((section) => section.textContent)).toEqual([
      "OutputsRoutines",
      "RenameShare chatDelete",
    ]);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain(
      "text-destructive",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Share chat" }));
    expect(ran).toEqual(["share"]);
    expect(items()).toEqual([]);
  });

  it("stays open while the pointer crosses from the button to the menu", async () => {
    const { more } = renderActions();
    fireEvent.pointerEnter(more, { pointerType: "mouse" });
    fireEvent.pointerLeave(more, { pointerType: "mouse" });
    fireEvent.pointerEnter(screen.getByRole("menu"), { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(items()).toHaveLength(5);
    fireEvent.pointerLeave(screen.getByRole("menu"), { pointerType: "mouse" });
    await waitFor(() => expect(items()).toEqual([]));
  });

  it("opens on a tap too, and closes on Escape", async () => {
    const { more } = renderActions();
    fireEvent.click(more);
    expect(items()).toHaveLength(5);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(items()).toEqual([]));
  });

  it("names the model that answered last at its foot, as text only", () => {
    const { more } = renderActions({ caption: "Opus 5.5" });
    fireEvent.click(more);
    const caption = document.querySelector("[data-chat-header-menu-caption]");
    expect(caption?.textContent).toBe("Opus 5.5");
    expect(caption?.querySelector("button, a")).toBeNull();
  });

  it("moves focus into the menu on Arrow Down, and between its items", async () => {
    const { more } = renderActions();
    more.focus();
    fireEvent.keyDown(more, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Outputs"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Routines");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("Delete");
  });
});
