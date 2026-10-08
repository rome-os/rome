import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { FilterChipGroup } from "./filter-chip-group.js";
import { PageNav, PageNavLink } from "./page.js";

// jsdom performs no layout: every row reports 0 wide and never overflows. Each
// test fakes the geometry of a row that does, then restores the prototype.
const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0)) restore();
});

function fake<T extends object>(proto: T, key: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(proto, key);
  Object.defineProperty(proto, key, { configurable: true, ...descriptor });
  restores.push(() => {
    if (original) Object.defineProperty(proto, key, original);
    else delete (proto as Record<string, unknown>)[key];
  });
}

// A row 300px wide holding 800px of content, scrolled to `scrollLeft`.
function fakeOverflowingRows() {
  const scroll = new WeakMap<Element, number>();
  fake(HTMLElement.prototype, "scrollWidth", { get: () => 800 });
  fake(HTMLElement.prototype, "clientWidth", { get: () => 300 });
  fake(Element.prototype, "scrollLeft", {
    get(this: Element) {
      return scroll.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      scroll.set(this, Math.min(Math.max(value, 0), 500));
    },
  });
  // The row spans 0–300; the entries sit side by side, 100px apart.
  fake(HTMLElement.prototype, "getBoundingClientRect", {
    value(this: HTMLElement) {
      const at = (left: number, width: number) =>
        ({ left, right: left + width, top: 0, bottom: 40, width, height: 40 }) as DOMRect;
      if (this.tagName === "UL") return at(0, 300);
      const index = ["Appearance", "Connections", "Advanced"].indexOf(this.textContent ?? "");
      return index === 2 ? at(600, 90) : at(index * 100, 90);
    },
  });
}

function SettingsNav({ active }: { active: string }) {
  return (
    <PageNav aria-label="Settings">
      {["Appearance", "Connections", "Advanced"].map((name) => (
        <PageNavLink key={name} href={`/${name}`} active={name === active}>
          {name}
        </PageNavLink>
      ))}
    </PageNav>
  );
}

const chevrons = (root: ParentNode) => root.querySelectorAll('[data-slot="scroll-edge-button"]');

describe("scroll edge hints", () => {
  it("adds nothing to a row that fits", () => {
    const { container } = render(<SettingsNav active="Appearance" />);

    expect(chevrons(container)).toHaveLength(0);
  });

  it("marks a clipped end with a chevron kept out of the tab order and the tree", () => {
    fakeOverflowingRows();
    const { container } = render(<SettingsNav active="Appearance" />);

    const [chevron, ...rest] = chevrons(container);
    expect(rest).toHaveLength(0);
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    expect(chevron.getAttribute("tabindex")).toBe("-1");
    // The chevrons are not entries, so a reader still meets only the links.
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("scrolls a clipped active entry into view", () => {
    fakeOverflowingRows();
    const { container } = render(<SettingsNav active="Advanced" />);

    const list = container.querySelector("ul");
    // Right edge 690, row ends at 300, plus the 32px kept clear of the chevron.
    expect(list?.scrollLeft).toBe(422);
  });

  it("puts a FilterChipGroup's className on its frame and marks a clipped end there", () => {
    fakeOverflowingRows();
    const { container } = render(
      <FilterChipGroup
        aria-label="Filter"
        className="flex-1"
        options={[
          { value: "all", label: "All" },
          { value: "other", label: "Other" },
        ]}
        value="all"
        onValueChange={() => {}}
      />,
    );

    const frame = container.querySelector('[data-slot="filter-chip-frame"]');
    expect(frame?.classList.contains("flex-1")).toBe(true);
    expect(chevrons(frame as Element)).toHaveLength(1);
  });
});
