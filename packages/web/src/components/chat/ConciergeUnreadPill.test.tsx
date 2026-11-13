// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { useState } from "react";
import { ConciergeUnreadPill } from "./ConciergeUnreadPill";
import i18n from "@/i18n";

// The scroller shows 0 to 600. The divider sits at `dividerTop` and is 20 tall.
let dividerTop = -300;
let scrollTop = 1000;
const jumped = rs.fn();

function Harness({
  count = 3,
  more = false,
  withDivider = true,
  anchored = true,
}: {
  count?: number;
  more?: boolean;
  withDivider?: boolean;
  anchored?: boolean;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} data-testid="scroller">
      <div ref={setContent}>
        {withDivider ? <div data-concierge-unread-divider data-testid="divider" /> : null}
      </div>
      <ConciergeUnreadPill
        scroller={scroller}
        content={content}
        count={count}
        more={more}
        anchored={anchored}
        onJump={jumped}
      />
    </div>
  );
}

/** Waits out the pill's settling time. */
async function settled() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
}

/** Lets the pill's frame-scheduled measure run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

async function scrollTo(top: number, divider: number) {
  scrollTop = top;
  dividerTop = divider;
  fireEvent.scroll(screen.getByTestId("scroller"));
  await settle();
}

beforeEach(() => {
  dividerTop = -300;
  scrollTop = 1000;
  rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const isScroller = this.dataset.testid === "scroller";
    const top = isScroller ? 0 : dividerTop;
    const height = isScroller ? 600 : 20;
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
  // The transcript is 1600 tall and 600 shows, so 1000 is its bottom.
  for (const [name, value] of Object.entries({ scrollHeight: 1600, clientHeight: 600 })) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
  });
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  for (const name of ["scrollHeight", "clientHeight", "scrollTop"])
    Reflect.deleteProperty(HTMLElement.prototype, name);
  rs.restoreAllMocks();
  rs.clearAllMocks();
});

describe("ConciergeUnreadPill", () => {
  it("shows the count while the divider is above the transcript", async () => {
    render(<Harness count={3} />);
    await settle();
    expect(screen.getByRole("button", { name: "3 new messages" })).toBeTruthy();
  });

  it("reads one message in the singular", async () => {
    render(<Harness count={1} />);
    await settle();
    expect(screen.getByRole("button", { name: "1 new message" })).toBeTruthy();
  });

  it("reads N+ while more unread messages wait on an older page", async () => {
    render(<Harness count={12} more withDivider={false} anchored={false} />);
    await settle();
    expect(screen.getByRole("button", { name: "12+ new messages" })).toBeTruthy();
  });

  it("speaks Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<Harness count={3} />);
    await settle();
    expect(screen.getByRole("button", { name: "3 条新消息" })).toBeTruthy();
  });

  it("shows no pill when the divider is in view at the bottom", async () => {
    dividerTop = 400;
    render(<Harness />);
    await settled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays away for good when the divider was in view, even once new messages push it up", async () => {
    dividerTop = 400;
    render(<Harness />);
    await settled();
    await scrollTo(1000, -50);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the pill when content that loads late pushes a divider out of view", async () => {
    dividerTop = 400;
    render(<Harness />);
    await settle();
    await scrollTo(1000, -50);
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("ignores a divider in view before the transcript reaches the bottom", async () => {
    scrollTop = 0;
    dividerTop = 100;
    render(<Harness />);
    await settle();
    expect(screen.queryByRole("button")).toBeNull();
    await scrollTo(1000, -300);
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("counts the divider under the scroller's top padding as out of view", async () => {
    scrollTop = 1000;
    dividerTop = 50;
    const padding = rs
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ scrollPaddingTop: "100px" } as CSSStyleDeclaration);
    render(<Harness />);
    await settle();
    expect(screen.getByRole("button")).toBeTruthy();
    padding.mockRestore();
  });

  it("goes away when the guardian scrolls up to the divider, and stays away", async () => {
    render(<Harness />);
    await settle();
    expect(screen.getByRole("button")).toBeTruthy();
    await scrollTo(600, 100);
    expect(screen.queryByRole("button")).toBeNull();
    await scrollTo(1000, -300);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("jumps and goes away when tapped", async () => {
    render(<Harness />);
    await settle();
    fireEvent.click(screen.getByRole("button"));
    expect(jumped).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button")).toBeNull();
    await scrollTo(1000, -300);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows while the divider's message is still on an older page", async () => {
    render(<Harness withDivider={false} anchored={false} />);
    await settle();
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("shows no pill when the chat draws nothing for the unread messages", async () => {
    render(<Harness withDivider={false} anchored />);
    await settle();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
