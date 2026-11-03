// @rstest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { openChatSearch } from "@/lib/chat-search-events";

rs.mock("./ChatSearchDialog", () => ({
  ChatSearchDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog">
        <button type="button" onClick={() => onOpenChange(false)}>
          close
        </button>
      </div>
    ) : null,
}));

import { ChatSearchHost } from "./ChatSearchHost";

afterEach(() => cleanup());

function host() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Link to="/apps">go to apps</Link>
      <ChatSearchHost />
    </MemoryRouter>,
  );
}

describe("ChatSearchHost", () => {
  it("opens when asked from anywhere, and closes itself", () => {
    host();
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => openChatSearch());
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => screen.getByRole("button", { name: "close" }).click());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when the page changes", () => {
    host();
    act(() => openChatSearch());
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => screen.getByRole("link", { name: "go to apps" }).click());

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stops listening when it unmounts", () => {
    const { unmount } = host();
    unmount();
    expect(() => act(() => openChatSearch())).not.toThrow();
  });
});
