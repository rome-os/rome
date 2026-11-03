// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useComposedInput } from "./use-composed-input";

function Box({ value }: { value: string }) {
  return <input aria-label="box" {...useComposedInput(value, () => {})} />;
}

afterEach(cleanup);

describe("useComposedInput", () => {
  it("holds a composition until the value catches up, then follows the value", () => {
    const { rerender } = render(<Box value="" />);
    const box = screen.getByLabelText("box") as HTMLInputElement;

    fireEvent.input(box, { target: { value: "shoushi" }, isComposing: true });
    expect(box.value).toBe("shoushi");

    fireEvent.input(box, { target: { value: "收拾" }, isComposing: true });
    fireEvent.compositionEnd(box);
    expect(box.value).toBe("收拾");

    rerender(<Box value="收拾" />);
    rerender(<Box value="nadia" />);
    expect(box.value).toBe("nadia");
  });

  it("follows back after repeated drafts", () => {
    const { rerender } = render(<Box value="" />);
    const box = screen.getByLabelText("box") as HTMLInputElement;

    fireEvent.input(box, { target: { value: "a" } });
    fireEvent.input(box, { target: { value: "ab" } });
    fireEvent.input(box, { target: { value: "a" } });
    rerender(<Box value="a" />);
    rerender(<Box value="ab" />);
    expect(box.value).toBe("ab");
  });
});
