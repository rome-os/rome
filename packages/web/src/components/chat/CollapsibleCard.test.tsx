// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CollapsibleCard, CollapsibleSection } from "./CollapsibleCard";

afterEach(() => cleanup());

function Card() {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleCard>
      <CollapsibleSection open={open} onOpenChange={setOpen} title="Recap" meta="0:42">
        Rewrote the closing paragraph.
      </CollapsibleSection>
    </CollapsibleCard>
  );
}

describe("CollapsibleSection", () => {
  it("wires the header to the body and toggles it", () => {
    render(<Card />);
    const header = screen.getByRole("button", { name: "Recap 0:42" });
    const body = document.getElementById(header.getAttribute("aria-controls") ?? "");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(body?.hidden).toBe(true);
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(body?.hidden).toBe(false);
  });

  it("shows keyboard focus with the outline recipe, not the hover tint alone", () => {
    render(<Card />);
    // The hover tint is ~1.2:1 against the card, under the 3:1 a focus
    // indicator needs, so the outline carries it. `outline-solid` is
    // load-bearing: outline-1 reads a style variable that defaults to none.
    const header = screen.getByRole("button", { name: "Recap 0:42" }).className;
    expect(header).toContain("focus-visible:outline-solid");
    expect(header).toContain("outline-1");
    expect(header).toContain("outline-transparent");
    expect(header).toContain("focus-visible:outline-ring/50");
    expect(header).not.toContain("outline-none");
  });
});
