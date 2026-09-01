// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAppRemixResume } from "./use-app-remix-resume";

const auth = rs.hoisted(() => ({ bootstrap: { phase: "needs-signin" } }));
rs.mock("@/lib/auth-state", () => ({ useAuthStateSnapshot: () => auth }));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  auth.bootstrap.phase = "needs-signin";
});

function Host() {
  const resume = useAppRemixResume();
  const location = useLocation();
  const navigate = useNavigate();
  return resume ? (
    <Navigate to={resume} replace />
  ) : (
    <>
      <output>
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate("/login", { replace: true })}>Login</button>
    </>
  );
}
const intent = { listingId: "@alice/calendar", version: "1.2.3" };
const path = `/remix-app?${new URLSearchParams(intent)}`;

describe("Remix login resume", () => {
  it("returns to confirmation after signing in and consumes the saved intent", async () => {
    const view = render(
      <MemoryRouter initialEntries={[path]}>
        <Host />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    expect(screen.getByRole("status").textContent).toBe("/login");
    auth.bootstrap.phase = "ready";
    view.rerender(
      <MemoryRouter initialEntries={[path]}>
        <Host />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(path));
    expect(sessionStorage.getItem("rome:pending-app-remix")).toBeNull();
  });

  it("survives a Cloud login full-page roundtrip in the same tab", async () => {
    const first = render(
      <MemoryRouter initialEntries={[path]}>
        <Host />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    first.unmount();
    auth.bootstrap.phase = "ready";
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Host />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(path));
  });

  it.each([
    { intent, expiresAt: 1 },
    { intent: null, expiresAt: Date.now() + 60000 },
    { intent: { ...intent, prompt: "untrusted instructions" }, expiresAt: Date.now() + 60000 },
    {
      intent: { listingId: "https://attacker.example", version: "1.0.0" },
      expiresAt: Date.now() + 60000,
    },
    { intent: { ...intent, version: "latest" }, expiresAt: Date.now() + 60000 },
  ])("ignores stale or invalid stored intent %j", async (value) => {
    sessionStorage.setItem("rome:pending-app-remix", JSON.stringify(value));
    auth.bootstrap.phase = "ready";
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Host />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status").textContent).toBe("/");
  });
});
