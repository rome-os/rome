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

    expect(wrapper?.classList).toContain("h-[var(--control-h-md)]");
    expect(wrapper?.classList).toContain("rounded-[var(--control-r-md)]");
    expect(wrapper?.classList).toContain("px-[var(--control-px-start-md)]");
    expect(wrapper?.classList).toContain("has-[input:focus-visible]:outline-ring");
    expect(wrapper?.classList).toContain("has-[input[aria-invalid=true]]:outline-destructive");
    expect(wrapper?.classList).not.toContain("focus-within:outline-ring");
    expect(input.classList).not.toContain("py-3");
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
