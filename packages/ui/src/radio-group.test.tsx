import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { RadioGroup, RadioGroupItem } from "./radio-group.js";

afterEach(cleanup);

function Group({
  value,
  onValueChange,
  disabled,
}: {
  value: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <RadioGroup aria-label="Access" value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadioGroupItem value="private" aria-label="Private" />
      <RadioGroupItem value="public" aria-label="Public" />
      <RadioGroupItem value="email" aria-label="By email" />
    </RadioGroup>
  );
}

describe("RadioGroup", () => {
  it("is a radiogroup of radios with one checked", () => {
    render(<Group value="public" />);

    expect(screen.getByRole("radiogroup", { name: "Access" })).toBeDefined();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Public" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Private" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("reports the option the caller should move to", () => {
    const onValueChange = rs.fn();
    render(<Group value="private" onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "By email" }));

    expect(onValueChange).toHaveBeenLastCalledWith("email");
  });

  it("tracks the state a caller drives from the callback", () => {
    function Form() {
      const [value, setValue] = useState("private");
      return <Group value={value} onValueChange={setValue} />;
    }
    render(<Form />);

    fireEvent.click(screen.getByRole("radio", { name: "Public" }));

    expect(screen.getByRole("radio", { name: "Public" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Private" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("moves the pick with the arrow keys", async () => {
    function Form() {
      const [value, setValue] = useState("private");
      return <Group value={value} onValueChange={setValue} />;
    }
    render(<Form />);
    const first = screen.getByRole("radio", { name: "Private" });
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowDown" });

    // Radix moves focus to the next item on a later tick and checks it on
    // arrival — the behaviour a row of `role="radio"` buttons promises and lacks.
    const second = screen.getByRole("radio", { name: "Public" });
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(second.getAttribute("aria-checked")).toBe("true");
  });

  it("does not report a change while disabled", () => {
    const onValueChange = rs.fn();
    render(<Group value="private" onValueChange={onValueChange} disabled />);

    fireEvent.click(screen.getByRole("radio", { name: "Public" }));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("sizes an item off the control scale and widens its hit area", () => {
    render(<Group value="private" />);

    const item = screen.getByRole("radio", { name: "Private" });
    const cls = [...item.classList];
    expect(cls).toContain("size-4");
    expect(cls).toContain("rounded-full");
    expect(item.className).not.toMatch(/--control-/);
    expect(cls).toContain("after:-inset-x-3");
    // Half the group's own gap, so one option's hit area stops before the
    // next option's box begins.
    expect(cls).toContain("after:-inset-y-1");
    expect(cls).not.toContain("after:-inset-3");
  });

  // The 12px axis is the one with no neighbour on it, so it has to follow the
  // orientation rather than assume the group stacks downward.
  it("swaps the hit-area axes when the group runs horizontally", () => {
    render(
      <RadioGroup
        orientation="horizontal"
        aria-label="Access"
        value="private"
        onValueChange={() => {}}
      >
        <RadioGroupItem value="private" aria-label="Private" />
        <RadioGroupItem value="public" aria-label="Public" />
      </RadioGroup>,
    );

    const item = screen.getByRole("radio", { name: "Private" });
    expect(item.getAttribute("data-orientation")).toBe("horizontal");
    const cls = [...item.classList];
    expect(cls).toContain("data-[orientation=horizontal]:after:-inset-x-1");
    expect(cls).toContain("data-[orientation=horizontal]:after:-inset-y-3");
  });

  it("paints nothing on the group beyond the gap", () => {
    render(<Group value="private" />);

    const cls = [...screen.getByRole("radiogroup").classList];
    expect(cls).toEqual(["grid", "gap-2", "data-[orientation=horizontal]:grid-flow-col"]);
  });

  // The layout and the hit area read the same attribute. A group that says
  // horizontal and stacks downward would give every item the 12px inset on the
  // axis its neighbour is actually on.
  // `@ts-expect-error` is the assertion: `pnpm typecheck` covers this file, so
  // the line fails the build the day an unnamed group starts compiling.
  it("does not accept a group without an accessible name", () => {
    render(
      // @ts-expect-error a radiogroup with no accessible name is unusable
      <RadioGroup value="private" onValueChange={() => {}}>
        <RadioGroupItem value="private" aria-label="Private" />
      </RadioGroup>,
    );

    expect(screen.getByRole("radiogroup")).not.toBeNull();
  });

  it("takes a name from aria-labelledby instead", () => {
    render(
      <>
        <span id="access-label">Access</span>
        <RadioGroup aria-labelledby="access-label" value="private" onValueChange={() => {}}>
          <RadioGroupItem value="private" aria-label="Private" />
        </RadioGroup>
      </>,
    );

    expect(screen.getByRole("radiogroup", { name: "Access" })).not.toBeNull();
  });

  it("lays its items out along its own orientation", () => {
    render(
      <RadioGroup
        orientation="horizontal"
        aria-label="Access"
        value="private"
        onValueChange={() => {}}
      >
        <RadioGroupItem value="private" aria-label="Private" />
      </RadioGroup>,
    );

    const group = screen.getByRole("radiogroup");
    expect(group.getAttribute("data-orientation")).toBe("horizontal");
    expect([...group.classList]).toContain("data-[orientation=horizontal]:grid-flow-col");
  });

  it("draws focus as an outline outside the box", () => {
    render(<Group value="private" />);

    const cls = [...screen.getByRole("radio", { name: "Private" }).classList];
    expect(cls).toContain("outline-1");
    expect(cls).toContain("outline-offset-0");
    expect(cls).toContain("outline-transparent");
    expect(cls).toContain("focus-visible:outline-solid");
    expect(cls).toContain("focus-visible:outline-ring/50");
    expect(cls.some((token) => /^focus-visible:-outline-offset-/.test(token))).toBe(false);
  });
});
