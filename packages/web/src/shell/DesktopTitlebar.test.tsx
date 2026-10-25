// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Link, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import { SlotContent, SlotProvider } from "@/components/slot";
import { DesktopTitlebar, TITLEBAR_END_SLOT, TITLEBAR_SLOT } from "./DesktopTitlebar";

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderBar(page: React.ReactNode = null) {
  render(
    <SlotProvider>
      <BrowserRouter>
        <DesktopTitlebar leadingWidth="4rem" />
        <Link to="/next">Next</Link>
        <Where />
        {page}
      </BrowserRouter>
    </SlotProvider>,
  );
  return document.querySelector<HTMLElement>("[data-app-titlebar]");
}

const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  if (platform) Object.defineProperty(Navigator.prototype, "platform", platform);
});

describe("DesktopTitlebar", () => {
  it("draws the page's bar and its panel's header inside itself", () => {
    const bar = renderBar(
      <>
        <SlotContent name={TITLEBAR_SLOT}>
          <h1>Apps</h1>
        </SlotContent>
        <SlotContent name={TITLEBAR_END_SLOT}>
          <span>Browser tab</span>
        </SlotContent>
      </>,
    );

    expect(bar).not.toBeNull();
    expect(within(bar!).getByRole("heading", { name: "Apps" })).toBeTruthy();
    expect(within(bar!).getByText("Browser tab")).toBeTruthy();
  });

  it("keeps back and forward shut until there is somewhere to go", async () => {
    const user = userEvent.setup();
    const bar = renderBar();
    const back = within(bar!).getByRole("button", { name: "Back" }) as HTMLButtonElement;
    const forward = within(bar!).getByRole("button", { name: "Forward" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);

    await user.click(screen.getByRole("link", { name: "Next" }));
    expect(back.disabled).toBe(false);

    await user.click(back);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/"));
    expect(forward.disabled).toBe(false);
  });

  it("goes back and forward on ⌘[ and ⌘] on a Mac", async () => {
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      get: () => "MacIntel",
    });
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("link", { name: "Next" }));

    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/"));

    fireEvent.keyDown(window, { key: "]", metaKey: true });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/next"));
  });
});
