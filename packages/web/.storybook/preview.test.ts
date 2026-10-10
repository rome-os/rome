// @rstest-environment jsdom
import { afterEach, expect, test } from "@rstest/core";

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
  document.getElementById("rome-theme-tokens")?.remove();
});

test("preview bootstrap applies the saved theme before any story mounts", async () => {
  localStorage.setItem("rome-theme", "dark");
  localStorage.setItem("rome-theme-name", "slate");

  await import("./preview");

  expect(document.documentElement.dataset.theme).toBe("slate");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe("dark");
});
