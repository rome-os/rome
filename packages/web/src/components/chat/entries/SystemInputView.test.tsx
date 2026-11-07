// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SystemInputView } from "./SystemInputView";

describe("SystemInputView", () => {
  afterEach(() => cleanup());

  it("shows the label collapsed, and the turn's input once opened", () => {
    const content = '<external_events untrusted="true" delivery="important">…</external_events>';
    const { container } = render(
      <SystemInputView label="Following · important (1)" content={content} />,
    );
    expect(screen.getByText("Following · important (1)")).toBeTruthy();
    expect(container.querySelector("[data-system-input]")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("[data-system-input]")?.textContent).toBe(content);
  });
});
