import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ProgressiveBlur } from "./progressive-blur.js";

afterEach(cleanup);

describe("ProgressiveBlur", () => {
  it.each([
    "top",
    "bottom",
    "left",
    "right",
  ] as const)("increases blur toward the %s edge at the requested strength", (direction) => {
    const { container } = render(<ProgressiveBlur direction={direction} maxBlur={32} />);
    const layers = [...container.querySelectorAll("span")];

    expect(layers.map((layer) => layer.style.backdropFilter)).toEqual([
      "blur(4px)",
      "blur(8px)",
      "blur(16px)",
      "blur(32px)",
    ]);
    // CSSOM omits the default gradient direction, `to bottom`.
    expect(layers[0].style.maskImage).toContain(
      direction === "bottom" ? "linear-gradient(transparent" : `linear-gradient(to ${direction}`,
    );
    expect(layers[0].style.maskImage).toContain("transparent 0%");
    expect(layers.at(-1)?.style.maskImage).toContain("black 100%");
  });

  it("keeps the decoration out of the accessibility tree and lets callers place it", () => {
    const { container } = render(
      <ProgressiveBlur className="top-auto h-24" style={{ bottom: 8 }} aria-hidden={false} />,
    );
    const root = container.firstElementChild as HTMLElement;

    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.classList.contains("pointer-events-none")).toBe(true);
    expect(root.classList.contains("top-auto")).toBe(true);
    expect(root.classList.contains("h-24")).toBe(true);
    expect(root.style.bottom).toBe("8px");
  });

  it("adds the optional tint after the blur layers", () => {
    const { container } = render(<ProgressiveBlur tint="var(--surface)" />);
    const tint = container.querySelector("span:last-child") as HTMLElement;

    expect(tint.style.background).toContain("var(--surface)");
    expect(tint.style.backdropFilter).toBe("");
  });
});
