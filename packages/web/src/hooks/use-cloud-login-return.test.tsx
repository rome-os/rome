// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Navigate, useLocation } from "react-router-dom";
import { LOGIN_RETURN_STORAGE_KEY, rememberLoginReturn } from "@/lib/login-return";
import { useCloudLoginReturn } from "./use-cloud-login-return";

const auth = rs.hoisted(() => ({ bootstrap: { phase: "ready" } }));
rs.mock("@/lib/auth-state", () => ({ useAuthStateSnapshot: () => auth }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  auth.bootstrap.phase = "ready";
});

function Host() {
  const target = useCloudLoginReturn();
  const location = useLocation();
  return target ? (
    <Navigate to={target} replace />
  ) : (
    <output>
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Host />
    </MemoryRouter>,
  );
}

describe("Cloud sign-in return", () => {
  it("lands on the remembered page and consumes it", async () => {
    rememberLoginReturn("/full/apps/ttt");
    renderAt("/?cloud=success");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("/full/apps/ttt"));
    expect(window.localStorage.getItem(LOGIN_RETURN_STORAGE_KEY)).toBeNull();
  });

  it("stays home when nothing was remembered", () => {
    renderAt("/?cloud=success");
    expect(screen.getByRole("status").textContent).toBe("/?cloud=success");
  });

  it("waits for the session before leaving home", () => {
    auth.bootstrap.phase = "needs-signin";
    rememberLoginReturn("/full/apps/ttt");
    renderAt("/?cloud=success");
    expect(screen.getByRole("status").textContent).toBe("/?cloud=success");
    expect(window.localStorage.getItem(LOGIN_RETURN_STORAGE_KEY)).toBe("/full/apps/ttt");
  });

  it("ignores home reached any other way", () => {
    rememberLoginReturn("/full/apps/ttt");
    renderAt("/");
    expect(screen.getByRole("status").textContent).toBe("/");
    expect(window.localStorage.getItem(LOGIN_RETURN_STORAGE_KEY)).toBe("/full/apps/ttt");
  });
});
