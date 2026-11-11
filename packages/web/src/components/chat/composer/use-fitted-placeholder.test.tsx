// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useFittedPlaceholder } from "./use-fitted-placeholder";

// jsdom has no layout, so give the textarea a width and a canvas that measures
// one pixel per character: 20px of room fits 20 characters.
function Box({ name }: { name: string | null }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const placeholder = useFittedPlaceholder(ref, name, (n) => `Message in ${n}`);
  return <textarea ref={ref} placeholder={placeholder ?? "Message"} />;
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("useFittedPlaceholder", () => {
  const fit = (room: number) => {
    rs.stubGlobal("ResizeObserver", FakeResizeObserver);
    rs.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(room);
    rs.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: text.length }),
    } as unknown as CanvasRenderingContext2D);
  };

  it("keeps a name that fits whole", () => {
    fit(40);
    render(<Box name="Calendar" />);
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("Message in Calendar");
  });

  it("cuts a name that does not fit to an ellipsis on the same line", () => {
    fit(20);
    render(<Box name="Planning the long weekend" />);
    const text = screen.getByRole("textbox").getAttribute("placeholder")!;
    expect(text).toBe("Message in Planning…");
    expect(text.length).toBeLessThanOrEqual(20);
  });

  it("falls back to the whole text where there is no canvas to measure on", () => {
    rs.stubGlobal("ResizeObserver", FakeResizeObserver);
    rs.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<Box name="Planning the long weekend" />);
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe(
      "Message in Planning the long weekend",
    );
  });

  it("leaves the placeholder to the caller without a name", () => {
    fit(20);
    render(<Box name={null} />);
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("Message");
  });
});
