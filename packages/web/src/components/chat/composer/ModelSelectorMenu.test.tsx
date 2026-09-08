// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { ModelSelectorMenu } from "./ModelSelectorMenu";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

function baseProps() {
  return {
    open: true as const,
    onOpenChange: rs.fn(),
    value: "auto",
    onChange: rs.fn(),
    disabled: false,
  };
}

function optionLabels(): string[] {
  return screen.getAllByRole("option").map((node) => node.textContent?.trim() ?? "");
}

describe("model selector menu", () => {
  it("opens on the short curated list rather than every model", () => {
    render(<ModelSelectorMenu {...baseProps()} />);

    // Curated common set: Auto + one flagship per family. Uncommon rows such as
    // Haiku stay folded away until "show all" or a search.
    const labels = optionLabels();
    expect(labels).toContain("Auto");
    expect(labels).toContain("Opus 5");
    expect(labels).toContain("Sonnet");
    expect(labels).toContain("GPT-6 Astra");
    expect(labels).not.toContain("Haiku");
    expect(labels).not.toContain("GPT-5.6 Luna");
  });

  it("reveals the full family-grouped list behind show all", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorMenu {...baseProps()} />);

    await user.click(screen.getByRole("button", { name: "Show all models" }));

    const labels = optionLabels();
    expect(labels).toContain("Haiku");
    expect(labels).toContain("Fable");
    expect(labels).toContain("GPT-5.6 Luna");
    // Family headings make the long list scannable (issue #180, direction 2).
    expect(screen.getByText("Claude", { selector: "[cmdk-group-heading]" })).toBeTruthy();
    expect(screen.getByText("GPT", { selector: "[cmdk-group-heading]" })).toBeTruthy();
  });

  it("filters across every model as the guardian types, even from the short list", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorMenu {...baseProps()} />);

    await user.type(screen.getByPlaceholderText("Search models"), "haiku");

    await waitFor(() => {
      const labels = optionLabels();
      expect(labels).toEqual(["Haiku"]);
    });
    // Search already spans everything, so the show-all toggle is withheld.
    expect(screen.queryByRole("button", { name: /Show (all|fewer) models/ })).toBeNull();
  });

  it("shows an empty message when nothing matches the query", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorMenu {...baseProps()} />);

    await user.type(screen.getByPlaceholderText("Search models"), "zzzzz");

    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    expect(screen.getByText(/No models match/)).toBeTruthy();
  });

  it("keeps a selected uncommon model visible on the short list", () => {
    render(<ModelSelectorMenu {...baseProps()} value="claude-haiku" />);

    // Haiku is not curated, but the current selection is always shown so its
    // check stays visible without expanding.
    expect(optionLabels()).toContain("Haiku");
  });

  it("reports the picked model and closes the menu", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ModelSelectorMenu {...props} />);

    await user.click(screen.getByRole("option", { name: "Opus 5" }));

    expect(props.onChange).toHaveBeenCalledWith("claude-opus-5");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
