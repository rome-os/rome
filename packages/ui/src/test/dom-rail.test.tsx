// Guards the test rail the component tickets depend on: jsdom is the default
// environment, @testing-library can render and query, user-event can drive
// interactions, and the Radix stubs in setup.ts are installed. It deliberately
// renders a throwaway component rather than a kit export — the kit ships no
// components yet, and this file's job is the harness, not a public surface.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "@rstest/core";
import { cn } from "../cn.js";

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" className={cn("px-2", "px-4")} onClick={() => setCount((c) => c + 1)}>
      count {count}
    </button>
  );
}

it("renders and updates a component in jsdom", async () => {
  const user = userEvent.setup();
  render(<Counter />);

  const button = screen.getByRole("button", { name: "count 0" });
  expect(button).toHaveProperty("className", "px-4");

  await user.click(button);
  expect(screen.getByRole("button", { name: "count 1" })).toBeDefined();
});

it("installs the jsdom stubs Radix primitives need", () => {
  expect(typeof globalThis.ResizeObserver).toBe("function");
  expect(typeof Element.prototype.scrollIntoView).toBe("function");
});
