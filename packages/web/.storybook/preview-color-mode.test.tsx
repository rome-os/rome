// @rstest-environment jsdom
import { afterEach, expect, test } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentedControl } from "../src/components/ui/segmented-control";
import { ThemeProvider, useTheme } from "../src/hooks/use-theme";
import type { ThemePreference } from "../src/lib/theme";
import { ColorMode } from "./preview";

const modes: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function StoryColorModeControl() {
  const { preference, setPreference } = useTheme();

  return (
    <SegmentedControl
      aria-label="Color mode"
      options={modes}
      value={preference}
      onValueChange={(value) => setPreference(value as ThemePreference)}
    />
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
  document.getElementById("rome-theme-tokens")?.remove();
});

test("a story color-mode control can override the toolbar preference", async () => {
  const user = userEvent.setup();

  render(
    <ThemeProvider>
      <ColorMode mode="dark">
        <StoryColorModeControl />
      </ColorMode>
    </ThemeProvider>,
  );

  await user.click(screen.getByRole("radio", { name: "Light" }));

  expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
});
