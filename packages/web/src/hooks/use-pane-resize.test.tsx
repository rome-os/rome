// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { useState } from "react";
import { usePaneResize } from "./use-pane-resize";

function Pane({ onResizeEnd }: { onResizeEnd: (size: number) => void }) {
  const [size, setSize] = useState(300);
  const edge = usePaneResize({
    size,
    min: 200,
    max: 400,
    onResize: setSize,
    onResizeEnd,
    onReset: () => setSize(300),
  });
  return <div aria-label="edge" {...edge.separatorProps} />;
}

function setup() {
  const onResizeEnd = rs.fn();
  render(<Pane onResizeEnd={onResizeEnd} />);
  const edge = screen.getByRole("separator", { name: "edge" });
  return { edge, onResizeEnd, now: () => Number(edge.getAttribute("aria-valuenow")) };
}

describe("usePaneResize", () => {
  afterEach(cleanup);

  it("is a focusable separator the arrow keys move, within its bounds", () => {
    const { edge, onResizeEnd, now } = setup();
    expect(edge.tabIndex).toBe(0);
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(now()).toBe(324);
    expect(onResizeEnd).toHaveBeenLastCalledWith(324);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(now()).toBe(400);
  });

  it("resets on Home and on a double click", () => {
    const { edge, now } = setup();
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    fireEvent.keyDown(edge, { key: "Home" });
    expect(now()).toBe(300);
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    fireEvent.doubleClick(edge);
    expect(now()).toBe(300);
  });

  it("follows a drag and reports the size once it ends", () => {
    const { edge, onResizeEnd, now } = setup();
    let captured = false;
    edge.setPointerCapture = () => {
      captured = true;
    };
    edge.hasPointerCapture = () => captured;
    edge.releasePointerCapture = () => {
      captured = false;
    };
    fireEvent.pointerDown(edge, { button: 0, clientX: 500, pointerId: 1 });
    expect(edge.getAttribute("data-resizing")).toBe("true");
    fireEvent.pointerMove(edge, { clientX: 450, pointerId: 1 });
    expect(now()).toBe(250);
    fireEvent.pointerMove(edge, { clientX: 100, pointerId: 1 });
    expect(now()).toBe(200);
    expect(onResizeEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(edge, { clientX: 100, pointerId: 1 });
    expect(onResizeEnd).toHaveBeenCalledWith(200);
    expect(edge.getAttribute("data-resizing")).toBeNull();
  });
});
