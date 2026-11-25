// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { ModelSelectorMenu } from "./ModelSelectorMenu";
import { LARGE_MODEL_OPTIONS } from "@/lib/chat-constants";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

const SHOW_ALL = `Show all ${LARGE_MODEL_OPTIONS.length} models`;

function baseProps() {
  return {
    open: true as const,
    onOpenChange: rs.fn(),
    value: "auto",
    onChange: rs.fn(),
    disabled: false,
  };
}

function optionNames(): string[] {
  return screen.getAllByRole("option").map((o) => o.textContent?.trim() ?? "");
}

describe("ModelSelectorMenu", () => {
  it("shows only the curated common models and a show-all row when collapsed", () => {
    render(<ModelSelectorMenu {...baseProps()} />);

    const names = optionNames();
    // Curated set: auto + latest-generation flagship per family (GPT-6 Astra is
    // the newest OpenAI generation in the catalog).
    expect(names).toEqual(
      expect.arrayContaining(["Auto (default provider)", "Opus 5.5", "GPT-6 Astra"]),
    );
    // The long tail is folded away until the guardian expands or searches.
    expect(names).not.toContain("Sonnet 5.5");
    expect(names).not.toContain("Haiku 5.5");
    expect(screen.getByText(SHOW_ALL)).toBeTruthy();
  });

  it("keeps a pinned non-curated model visible (with its check) when collapsed", () => {
    render(<ModelSelectorMenu {...baseProps()} value="anthropic/claude-haiku-5-5" />);

    // Haiku is not curated, but it is the current selection, so it stays
    // visible without expanding — a deliberately pinned model is not stranded.
    const haiku = screen.getByRole("option", { name: /Haiku/ });
    expect(haiku.querySelector("svg")).not.toBeNull();
  });

  it("reveals the full catalog when show-all is chosen", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorMenu {...baseProps()} />);

    expect(optionNames()).not.toContain("Sonnet 5.5");
    await user.click(screen.getByText(SHOW_ALL));

    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBe(LARGE_MODEL_OPTIONS.length),
    );
    expect(optionNames()).toContain("Sonnet 5.5");
    // The show-all row is gone once everything is shown.
    expect(screen.queryByText(SHOW_ALL)).toBeNull();
  });

  it("filters across every model as the guardian types", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorMenu {...baseProps()} />);

    await user.type(screen.getByPlaceholderText("Search models…"), "sonnet");

    await waitFor(() => {
      const names = optionNames();
      expect(names).toContain("Sonnet 5.5");
      expect(names).not.toContain("Auto (default provider)");
    });
  });

  it("finds GPT-6.1 Sol and submits its model selection ID", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ModelSelectorMenu {...props} />);

    await user.type(screen.getByPlaceholderText("Search models…"), "6.1");
    await user.click(await screen.findByRole("option", { name: "GPT-6.1 Sol" }));

    expect(props.onChange).toHaveBeenCalledWith("openai/gpt-6.1-sol");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows an empty state when nothing matches", async () => {
    const user = userEvent.setup();
    render(<ModelSelectorMenu {...baseProps()} />);

    await user.type(screen.getByPlaceholderText("Search models…"), "nope-xyz");

    await waitFor(() => expect(screen.getByText("No matching models.")).toBeTruthy());
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("reports the picked model and closes when a row is chosen", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ModelSelectorMenu {...props} />);

    await user.click(screen.getByRole("option", { name: /Opus 5\.5/ }));

    expect(props.onChange).toHaveBeenCalledWith("anthropic/claude-opus-5-5[1m]");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("marks the current selection with a check and leaves other rows unmarked", () => {
    render(<ModelSelectorMenu {...baseProps()} value="auto" />);

    // The check mark is the only svg inside a model row.
    expect(screen.getByRole("option", { name: /Auto/ }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("option", { name: /GPT-6 Astra/ }).querySelector("svg")).toBeNull();
  });

  it("resets to the collapsed common view after a selection made from a filtered list", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { rerender } = render(<ModelSelectorMenu {...props} />);

    // Filter down to a non-curated model, then pick it — selection closes the menu.
    await user.type(screen.getByPlaceholderText("Search models…"), "sonnet");
    await waitFor(() => expect(optionNames()).toContain("Sonnet 5.5"));
    await user.click(screen.getByRole("option", { name: /Sonnet/ }));
    expect(props.onChange).toHaveBeenCalledWith("anthropic/claude-sonnet-5-5");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);

    // Selecting a row flips the parent's `open` prop rather than going through
    // the Popover's onOpenChange wrapper, so the reset must happen on the select
    // path too. Simulate the parent closing then reopening the menu.
    rerender(<ModelSelectorMenu {...props} open={false} />);
    rerender(<ModelSelectorMenu {...props} open={true} />);

    // Back to the curated rows + show-all — not the stale "sonnet" filter.
    const names = optionNames();
    expect(names).toEqual(
      expect.arrayContaining(["Auto (default provider)", "Opus 5.5", "GPT-6 Astra"]),
    );
    expect(names).not.toContain("Sonnet 5.5");
    expect(screen.getByText(SHOW_ALL)).toBeTruthy();
    // The search field is cleared too.
    expect((screen.getByPlaceholderText("Search models…") as HTMLInputElement).value).toBe("");
  });
});

describe("ModelSelectorMenu sign-ins", () => {
  it("offers only models of signed-in providers and labels Auto as following the default", () => {
    render(
      <ModelSelectorMenu
        {...baseProps()}
        signedIn={{ anthropic: true, openai: false, rome_credits: false }}
      />,
    );
    const names = optionNames();
    expect(names).toContain("Auto (default provider)");
    expect(names).toContain("Opus 5.5");
    expect(names).not.toContain("GPT-6 Astra");
  });

  it("keeps a selected model whose provider signed out", () => {
    render(
      <ModelSelectorMenu
        {...baseProps()}
        value="openai/gpt-6-luna"
        signedIn={{ anthropic: true, openai: false, rome_credits: false }}
      />,
    );
    expect(optionNames()).toContain("GPT-6 Luna");
  });
});

it.each([
  ["en", "anthropic/claude-opus-4-8[1m]", "Opus 4.8"],
  ["zh-CN", "anthropic/claude-opus-4-8[1m]", "Opus 4.8"],
  ["en", "anthropic/claude-sonnet-5-5", "Sonnet 5.5"],
  ["zh-CN", "anthropic/claude-haiku-5-5", "Haiku 5.5"],
  ["en", "anthropic/claude-fable-5-1[1m]", "Fable 5.1"],
])("keeps stored %s/%s selected with its exact version", async (language, value, label) => {
  await i18n.changeLanguage(language);
  const props = { ...baseProps(), value };
  const view = render(<ModelSelectorMenu {...props} />);
  try {
    const row = screen.getByRole("option", { name: label });
    expect(row.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: language === "en" ? "Model" : "模型" }).textContent,
    ).toContain(label);
    await userEvent.setup().click(row);
    expect(props.onChange).toHaveBeenCalledWith(value);
  } finally {
    view.unmount();
    await i18n.changeLanguage("en");
  }
});

it("shows an unknown saved choice verbatim instead of naming it Auto", () => {
  render(<ModelSelectorMenu {...baseProps()} value="unrecognized-old-choice" />);
  expect(screen.getByRole("button", { name: "Model" }).textContent).toContain(
    "unrecognized-old-choice",
  );
});
