import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";

const require = createRequire(import.meta.url);
const kitStylesPath = require.resolve("@rome-os/ui/styles.css");
const sonnerStylesPath = require.resolve("sonner/dist/styles.css");

const classes = [
  "bg-primary",
  "bg-surface-elevated",
  "bg-surface-muted",
  "border",
  "border-border",
  "focus-visible:outline-1",
  "focus-visible:outline-offset-0",
  "focus-visible:outline-ring",
  "focus-visible:outline-solid",
  "focus-visible:shadow-4!",
  "shadow-4",
  "text-foreground",
  "text-muted-foreground",
  "text-primary-foreground",
];

test("Sonner nested content uses Rome tokens in a dark app shadow root", async ({ page }) => {
  const compiler = await compile(`${readFileSync(kitStylesPath, "utf8")}\n@tailwind utilities;`, {
    base: dirname(kitStylesPath),
  });
  const compiledCss = `${readFileSync(sonnerStylesPath, "utf8")}\n${compiler.build(classes)}`;
  expect(compiledCss).toContain("background-color: var(--surface-elevated)");

  const colors = await page.evaluate((css) => {
    // Rome's host and app compile the same Tailwind canon. The document copy
    // registers Tailwind's typed shadow properties globally; the shadow copy
    // supplies the selectors that are intentionally scoped to the app.
    const hostStyle = document.createElement("style");
    hostStyle.textContent = css;
    document.head.append(hostStyle);

    const host = document.createElement("div");
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    shadowRoot.append(style);

    const appBody = document.createElement("body");
    appBody.className = "dark";
    appBody.style.cssText = `
      --surface: rgb(12 18 24);
      --surface-elevated: rgb(22 28 34);
      --foreground: rgb(238 242 246);
      --muted-foreground: rgb(151 161 171);
      --primary: rgb(31 129 222);
      --primary-foreground: rgb(250 252 255);
      --surface-muted: rgb(42 50 58);
      --border: rgb(72 82 92);
      --ring: rgb(91 166 236);
      --rome-shadow-4: 0 7px 11px rgb(1 2 3 / 0.65);
    `;
    shadowRoot.append(appBody);

    appBody.innerHTML = `
      <ol class="toaster group" data-sonner-toaster data-sonner-theme="light">
        <li
          class="group toast border border-border bg-surface-elevated text-foreground shadow-4 focus-visible:shadow-4!"
          data-sonner-toast
          data-styled="false"
          tabindex="0"
        >
          <div data-content>
            <div data-title>App installed</div>
            <div class="text-muted-foreground" data-description>Ready</div>
          </div>
          <button
            class="bg-primary text-primary-foreground focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            data-button
          >Undo</button>
          <button
            class="bg-surface-muted text-muted-foreground focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            data-button
            data-cancel
          >Cancel</button>
          <button
            class="border border-border bg-surface-elevated text-foreground focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-ring"
            data-close-button
          >Close</button>
        </li>
      </ol>
    `;

    const read = (selector: string) => {
      const element = appBody.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      const computed = getComputedStyle(element);
      return {
        background: computed.backgroundColor,
        border: computed.borderColor,
        boxShadow: computed.boxShadow,
        color: computed.color,
      };
    };

    const action = appBody.querySelector("[data-button]:not([data-cancel])") as HTMLButtonElement;
    action.focus();
    const focusedActionStyle = getComputedStyle(action);
    const focusedAction = {
      boxShadow: focusedActionStyle.boxShadow,
      outlineColor: focusedActionStyle.outlineColor,
    };

    const toast = appBody.querySelector("[data-sonner-toast]") as HTMLElement;
    const restingToast = read("[data-sonner-toast]");
    toast.focus();
    const focusedToast = getComputedStyle(toast);

    return {
      toast: restingToast,
      description: read("[data-description]"),
      action: read("[data-button]:not([data-cancel])"),
      cancel: read("[data-cancel]"),
      close: read("[data-close-button]"),
      focusedAction,
      focusedToastShadow: focusedToast.boxShadow,
    };
  }, compiledCss);

  expect(colors.description.color).toBe("rgb(151, 161, 171)");
  expect(colors.toast).toMatchObject({
    background: "rgb(22, 28, 34)",
    border: "rgb(72, 82, 92)",
  });
  expect(colors.toast.boxShadow).toContain("rgba(1, 2, 3, 0.65)");
  expect(colors.action).toMatchObject({
    background: "rgb(31, 129, 222)",
    color: "rgb(250, 252, 255)",
  });
  expect(colors.cancel).toMatchObject({
    background: "rgb(42, 50, 58)",
    color: "rgb(151, 161, 171)",
  });
  expect(colors.close).toMatchObject({
    background: "rgb(22, 28, 34)",
    border: "rgb(72, 82, 92)",
    color: "rgb(238, 242, 246)",
  });
  expect(colors.focusedAction).toEqual({
    boxShadow: "none",
    outlineColor: "rgb(91, 166, 236)",
  });
  expect(colors.focusedToastShadow).toContain("rgba(1, 2, 3, 0.65)");
});
