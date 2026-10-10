import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { Command, CommandInput, CommandItem, CommandList } from "./command.js";

afterEach(cleanup);

function renderCommand(handlers: { onSelect: () => void; onClear: () => void }) {
  render(
    <Command shouldFilter={false}>
      <CommandInput placeholder="Search…">
        <button type="button" onClick={handlers.onClear}>
          Clear
        </button>
      </CommandInput>
      <CommandList>
        <CommandItem value="only-item" onSelect={handlers.onSelect}>
          Only item
        </CommandItem>
      </CommandList>
    </Command>,
  );
}

describe("Command control geometry", () => {
  it("uses the shared md Control tokens on the input row", () => {
    render(
      <Command>
        <CommandInput placeholder="Search…" />
      </Command>,
    );

    const input = screen.getByPlaceholderText("Search…");
    const wrapper = input.closest('[data-slot="command-input-wrapper"]');

    // A `plain` Input carries the md height, inset and glyph reserve and no
    // radius, border or fill; the wrapper is the header row with its rule.
    expect(input.classList).toContain("h-[var(--control-h-md)]");
    expect(input.classList).toContain("px-[var(--control-px-start-md)]");
    expect(input.classList).toContain("rounded-none");
    expect(input.classList).toContain("border-transparent");
    expect(input.dataset.variant).toBe("plain");
    expect(wrapper?.classList).toContain("border-b");
    expect(wrapper?.classList).not.toContain("h-[var(--control-h-md)]");
    expect(input.classList).not.toContain("py-3");
  });

  // The row is a full-bleed header inside Command's `overflow-hidden`, so an
  // edge at `outline-offset: 0` renders clipped on three sides, and cmdk holds
  // focus here for the whole life of the surface, so one would never turn off.
  // Asserting the absence keeps a future "every Control gets the focus edge"
  // pass from reinstating it silently. See docs/ui/component-roles.md.
  it("paints no focus edge on the input row", () => {
    render(
      <Command>
        <CommandInput placeholder="Search…" />
      </Command>,
    );

    const input = screen.getByPlaceholderText("Search…");
    const wrapper = input.closest('[data-slot="command-input-wrapper"]');

    // cmdk never marks its field invalid, so the inherited invalid edge never
    // fires; only the focus edge is asserted absent.
    for (const cls of [...Array.from(wrapper?.classList ?? []), ...Array.from(input.classList)]) {
      expect(cls).not.toContain("outline-ring");
    }
    expect(input.classList).toContain("focus-visible:outline-transparent");
  });

  it("lets caller classes override the outer Control geometry", () => {
    render(
      <Command>
        <CommandInput className="h-10" inputClassName="text-aux" placeholder="Search…" />
      </Command>,
    );

    const input = screen.getByPlaceholderText("Search…");
    const wrapper = input.closest('[data-slot="command-input-wrapper"]');

    expect(wrapper?.classList).toContain("h-10");
    expect(wrapper?.classList).not.toContain("h-[var(--control-h-md)]");
    expect(input.classList).toContain("text-aux");
  });
});

describe("Command search field", () => {
  it("leaves the highlight alone when Home is pressed, so the caret keeps the key", async () => {
    // cmdk binds Home/End on its root to jump the highlight and preventDefaults
    // them, which takes the keys away from the caret. Guarded in the primitive,
    // so this holds for every caller, including the Routines action picker.
    const user = userEvent.setup();
    render(
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search…" />
        <CommandList>
          <CommandItem value="first" onSelect={rs.fn()}>
            First
          </CommandItem>
          <CommandItem value="second" onSelect={rs.fn()}>
            Second
          </CommandItem>
        </CommandList>
      </Command>,
    );

    screen.getByPlaceholderText("Search…").focus();
    await user.keyboard("{ArrowDown}");
    const selected = () =>
      screen.getAllByRole("option").find((o) => o.getAttribute("data-selected") === "true")
        ?.textContent;
    expect(selected()).toBe("Second");

    await user.keyboard("{Home}");
    expect(selected()).toBe("Second");
  });
});

describe("Command trailing input content", () => {
  it("activates a focused trailing button on Enter rather than the highlighted item", async () => {
    const onSelect = rs.fn();
    const onClear = rs.fn();
    const user = userEvent.setup();
    renderCommand({ onSelect, onClear });

    screen.getByRole("button", { name: "Clear" }).focus();
    await user.keyboard("{Enter}");

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still selects the highlighted item on Enter from the search field", async () => {
    const onSelect = rs.fn();
    const onClear = rs.fn();
    const user = userEvent.setup();
    renderCommand({ onSelect, onClear });

    screen.getByPlaceholderText("Search…").focus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });
});

describe("Command leading input content", () => {
  it("seats leading content in the glyph reserve and starts the text one gap past it", () => {
    render(
      <Command>
        <CommandInput placeholder="Search…" leading={<span>Scope</span>} />
      </Command>,
    );

    const input = screen.getByPlaceholderText("Search…");
    const leading = screen.getByText("Scope").closest('[data-slot="command-input-leading"]');

    expect(leading).not.toBeNull();
    expect(leading?.classList).toContain(
      "pl-[calc(var(--control-px-start-md)+1rem+var(--control-gap))]",
    );
    // The leading slot now owns the glyph reserve, so the field drops it.
    expect(input.classList).toContain("pl-[var(--control-gap)]");
    expect(input.classList).not.toContain(
      "pl-[calc(var(--control-px-start-md)+1rem+var(--control-gap))]",
    );
  });

  it("keeps the glyph reserve on the field when there is no leading content", () => {
    render(
      <Command>
        <CommandInput placeholder="Search…" />
      </Command>,
    );

    const input = screen.getByPlaceholderText("Search…");
    expect(
      input
        .closest('[data-slot="command-input-wrapper"]')
        ?.querySelector('[data-slot="command-input-leading"]'),
    ).toBeNull();
    expect(input.classList).toContain(
      "pl-[calc(var(--control-px-start-md)+1rem+var(--control-gap))]",
    );
  });

  it("activates a focused leading button on Enter rather than the highlighted item", async () => {
    const onSelect = rs.fn();
    const onRemove = rs.fn();
    const user = userEvent.setup();
    render(
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Search…"
          leading={
            <button type="button" onClick={onRemove}>
              Remove
            </button>
          }
        />
        <CommandList>
          <CommandItem value="only-item" onSelect={onSelect}>
            Only item
          </CommandItem>
        </CommandList>
      </Command>,
    );

    screen.getByRole("button", { name: "Remove" }).focus();
    await user.keyboard("{Enter}");

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
