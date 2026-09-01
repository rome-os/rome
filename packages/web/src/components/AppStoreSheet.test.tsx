// @rstest-environment jsdom
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import { AppStoreSheet } from "./AppStoreSheet";

rs.mock("@/lib/app-store-url", () => ({ APP_STORE_BROWSE_URL: "https://store.example/store" }));
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function Location() {
  const location = useLocation();
  return <output data-testid="location">{JSON.stringify(location)}</output>;
}
function setup(open = true) {
  const onClose = rs.fn();
  const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        available: true,
        listing: { id: "@alice/calendar", name: "Calendar", state: "published" },
        versions: [
          { version: "1.2.3", contentHash: "a".repeat(64), sourceAvailable: true, state: "live" },
        ],
      }),
    ),
  );
  render(
    <MemoryRouter>
      <AppStoreSheet open={open} onClose={onClose} onInstalled={rs.fn()} />
      <Location />
    </MemoryRouter>,
  );
  const iframe = document.querySelector("iframe");
  const message = (
    origin = "https://store.example",
    source: MessageEventSource | null = iframe?.contentWindow ?? null,
  ) =>
    new MessageEvent("message", {
      origin,
      source,
      data: { type: "rome:remix-request", listingId: "@alice/calendar", version: "1.2.3" },
    });
  return { fetch, onClose, message };
}

it("ignores other origins and windows, then accepts the open Store iframe", async () => {
  const { fetch, onClose, message } = setup();
  fireEvent(window, message("https://attacker.example"));
  fireEvent(window, message("https://store.example", window));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent(window, message());
  await screen.findByText("Calendar");
  fireEvent.click(screen.getByRole("button", { name: "Yes, continue in chat" }));
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toContain("coding:app_remix"),
  );
  expect(JSON.parse(screen.getByTestId("location").textContent ?? "{}").state).toEqual({
    skill: "coding:app_remix",
    draft: "I want to remix @alice/calendar version 1.2.3, with the following changes:\n\n",
  });
  expect(onClose).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("ignores repeated intents while confirmation is open and can cancel without navigation", async () => {
  const { fetch, onClose, message } = setup();
  fireEvent(window, message());
  fireEvent(window, message());
  await screen.findByText("Calendar");
  fireEvent.click(screen.getByRole("button", { name: "No, cancel" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId("location").textContent).not.toContain("/chat");
});

it("ignores messages when the Store sheet is closed", () => {
  const { fetch, message } = setup(false);
  fireEvent(window, message());
  expect(fetch).not.toHaveBeenCalled();
});
