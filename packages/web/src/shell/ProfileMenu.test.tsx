// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DashboardIdentity } from "@rome/api-types";
import i18n from "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { ProfileMenu } from "./ProfileMenu";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function mockIdentity(identity: DashboardIdentity) {
  return rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/me") {
      return new Response(JSON.stringify(identity), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/auth/logout" && init?.method === "POST") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ProfileMenu />
          <LocationProbe />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("ProfileMenu", () => {
  it("shows the guardian's initial and name — identically for password and cloud sign-in", async () => {
    // Both login methods mint the same session, so both surface as this
    // identity; there is nothing login-method-specific to render.
    mockIdentity({ kind: "guardian", userId: "u1", displayName: "Evan", avatarUrl: null });
    renderMenu();

    await waitFor(() => expect(screen.getByText("E")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByText("Evan")).toBeTruthy();
    expect(screen.getByText("Guardian")).toBeTruthy();
    const menuItems = ["Settings", "Feedback", "Log out"].map((name) =>
      screen.getByRole("menuitem", { name }),
    );
    expect(menuItems.every((item) => item.className.includes("text-ui"))).toBe(true);
  });

  it("opens the feedback dialog from the Feedback menu item", async () => {
    mockIdentity({ kind: "guardian", userId: "u1", displayName: "Evan", avatarUrl: null });
    renderMenu();

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Feedback" }));

    expect(await screen.findByRole("textbox", { name: "Share feedback" })).toBeTruthy();
  });

  it("falls back to the Guardian role label when no display name is set", async () => {
    mockIdentity({ kind: "guardian", userId: "u1", displayName: null, avatarUrl: null });
    renderMenu();

    await waitFor(() => expect(screen.getByText("G")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByText("Guardian")).toBeTruthy();
  });

  it("shows a dashboard visitor's email", async () => {
    mockIdentity({
      kind: "visitor",
      accountId: "acc-1",
      email: "friend@example.com",
      avatarUrl: null,
    });
    renderMenu();

    await waitFor(() => expect(screen.getByText("F")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByText("friend@example.com")).toBeTruthy();
    expect(screen.getByText("Visitor")).toBeTruthy();
  });

  it("navigates to /settings from the menu", async () => {
    mockIdentity({ kind: "guardian", userId: "u1", displayName: "Evan", avatarUrl: null });
    renderMenu();

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/settings"));
  });

  it("logs out via POST /api/auth/logout and leaves for /login", async () => {
    const fetchSpy = mockIdentity({
      kind: "guardian",
      userId: "u1",
      displayName: "Evan",
      avatarUrl: null,
    });
    const assign = rs.fn();
    rs.stubGlobal("location", { ...window.location, assign });
    renderMenu();

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Log out" }));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([input, init]) => String(input) === "/api/auth/logout" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("renders the cloud avatar when one is available", async () => {
    class LoadedImage extends EventTarget {
      complete = true;
      naturalWidth = 32;
      src = "";
    }
    rs.stubGlobal("Image", LoadedImage);
    mockIdentity({
      kind: "guardian",
      userId: "u1",
      displayName: "Evan",
      avatarUrl: "https://example.com/avatar.png",
    });
    const view = renderMenu();

    await waitFor(() => {
      const image = view.container.querySelector('[data-slot="avatar-image"]');
      expect(image?.getAttribute("src")).toBe("https://example.com/avatar.png");
    });
  });
});
