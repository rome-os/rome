// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { Roll } from "@/components/motion/Roll";

afterEach(cleanup);

describe("Roll", () => {
  it("shows a screen reader only the current value while the old one leaves", () => {
    const { rerender } = render(<Roll value="Working" />);
    rerender(<Roll value="Broken" />);

    expect(screen.getByText("Broken").getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByText("Working").getAttribute("aria-hidden")).toBe("true");
  });
});
