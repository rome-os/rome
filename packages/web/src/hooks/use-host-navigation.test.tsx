// @rstest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useHostNavigation } from "./use-host-navigation";

function Harness() {
  useHostNavigation();
  return <LocationProbe />;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="pathname">{location.pathname}</div>
      <div data-testid="draft">{(location.state as { draft?: string } | null)?.draft ?? ""}</div>
    </>
  );
}

function renderHarness() {
  render(
    <MemoryRouter initialEntries={["/apps/demo"]}>
      <Routes>
        <Route path="*" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("useHostNavigation", () => {
  it("handles same-origin host navigation messages from iframes", async () => {
    renderHarness();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "rome:host-navigate",
            detail: { path: "/chat", state: { draft: "Review this" } },
          },
        }),
      );
    });

    await waitFor(() => expect(screen.getByTestId("pathname").textContent).toBe("/chat"));
    expect(screen.getByTestId("draft").textContent).toBe("Review this");
  });

  it("handles same-origin Rome session navigation messages from iframes", async () => {
    renderHarness();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "rome:host-navigate",
            detail: { path: "/sessions/action%3Aexec-1%3Areviewer" },
          },
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("pathname").textContent).toBe(
        "/sessions/action%3Aexec-1%3Areviewer",
      ),
    );
  });

  it("ignores cross-origin host navigation messages", async () => {
    renderHarness();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://example.invalid",
          data: {
            type: "rome:host-navigate",
            detail: { path: "/chat" },
          },
        }),
      );
    });

    await waitFor(() => expect(screen.getByTestId("pathname").textContent).toBe("/apps/demo"));
  });

  it("ignores same-origin non-chat host navigation messages", async () => {
    renderHarness();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "rome:host-navigate",
            detail: { path: "/settings/connections" },
          },
        }),
      );
    });

    await waitFor(() => expect(screen.getByTestId("pathname").textContent).toBe("/apps/demo"));
  });
});
