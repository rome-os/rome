// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { SpokenRecapsRows } from "./spoken-recaps-section";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function setup(enabled = false, createAudio = false) {
  let stored = { enabled, createAudio, threshold: "medium", audioSpeed: "faster" };
  const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    if (init?.method === "PUT") stored = JSON.parse(String(init.body));
    return Response.json(stored);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SpokenRecapsRows />
    </QueryClientProvider>,
  );
  return fetchSpy;
}

describe("Spoken recaps settings", () => {
  it("shows only the on switch while recaps are off", async () => {
    setup();
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Create recaps" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.getByText(/Each uses an extra model call/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Length threshold" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Create audio" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Audio speed" })).toBeNull();
  });

  it("saves the on switch to the System app and shows speed only after audio is enabled", async () => {
    const fetchSpy = setup();
    const master = screen.getByRole("switch", { name: "Create recaps" });
    await waitFor(() => expect(master.hasAttribute("disabled")).toBe(false));
    fireEvent.click(master);
    await waitFor(() => expect(master.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Create audio" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("combobox", { name: "Audio speed" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Create audio" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Audio speed" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/apps/system/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          createAudio: true,
          threshold: "medium",
          audioSpeed: "faster",
        }),
      }),
    );
    fireEvent.click(master);
    await waitFor(() => expect(master.getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByRole("switch", { name: "Create audio" })).toBeNull();
  });

  it("keeps the saved state and reports a failed write inline", async () => {
    const fetchSpy = setup(true, true);
    const master = screen.getByRole("switch", { name: "Create recaps" });
    await waitFor(() => expect(master.hasAttribute("disabled")).toBe(false));
    fetchSpy.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    fireEvent.click(master);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Recap settings didn’t load or save.");
    expect(alert.textContent).not.toContain("forbidden");
    expect(master.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
