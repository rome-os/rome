// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider, useTheme } from "@/hooks/use-theme";
import { THEME_NAME_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/theme";
import StyleGuidePage from "./StyleGuidePage";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
});

function ThemeControls() {
  const { toggle, setTheme } = useTheme();
  return (
    <>
      <button onClick={toggle}>Toggle mode</button>
      <button onClick={() => setTheme("slate")}>Select Slate</button>
    </>
  );
}

function specimenModes(container: HTMLElement) {
  const columns = [...container.querySelectorAll<HTMLElement>("[data-theme]")];
  return columns.map((column) => ({
    theme: column.dataset.theme,
    mode: column.classList.contains("dark")
      ? "dark"
      : column.classList.contains("light")
        ? "light"
        : null,
    shadow: Boolean(column.firstElementChild?.shadowRoot),
  }));
}

describe("StyleGuidePage mode scoping", () => {
  it("keeps both comparison modes scoped when the host mode and palette change", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    localStorage.setItem(THEME_NAME_STORAGE_KEY, "ash");
    const { container } = render(
      <ThemeProvider>
        <ThemeControls />
        <StyleGuidePage />
      </ThemeProvider>,
    );

    const expected = (theme: string) => [
      { theme, mode: "light", shadow: false },
      { theme, mode: "dark", shadow: false },
      { theme, mode: "light", shadow: true },
      { theme, mode: "dark", shadow: true },
    ];
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(specimenModes(container)).toEqual(expected("ash"));
    fireEvent.click(screen.getByRole("button", { name: "Toggle mode" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(specimenModes(container)).toEqual(expected("ash"));
    fireEvent.click(screen.getByRole("button", { name: "Select Slate" }));
    expect(specimenModes(container)).toEqual(expected("slate"));
  });

  it("follows the active mode and palette in both single-mode specimens", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    localStorage.setItem(THEME_NAME_STORAGE_KEY, "ash");
    const { container } = render(
      <ThemeProvider>
        <ThemeControls />
        <StyleGuidePage compareModes={false} />
      </ThemeProvider>,
    );
    expect(specimenModes(container)).toEqual([
      { theme: "ash", mode: "light", shadow: false },
      { theme: "ash", mode: "light", shadow: true },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Toggle mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Slate" }));
    expect(specimenModes(container)).toEqual([
      { theme: "slate", mode: "dark", shadow: false },
      { theme: "slate", mode: "dark", shadow: true },
    ]);
  });
});
