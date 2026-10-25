// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { fetchAppApi } from "@rome-os/app-web-sdk";
import App from "../../../../rome_apps/system/src/web/App";

rs.mock("@rome-os/app-web-sdk", () => ({ fetchAppApi: rs.fn() }));

afterEach(() => {
  cleanup();
  rs.resetAllMocks();
});

function setup(enabled = false, createAudio = false) {
  let stored = { enabled, createAudio, threshold: "medium", audioSpeed: "faster" };
  rs.mocked(fetchAppApi).mockImplementation(async (_path, init) => {
    if (init?.method === "PUT") stored = JSON.parse(String(init.body));
    return Response.json(stored);
  });
  render(<App />);
}

describe("System spoken recaps", () => {
  it("keeps the settings visible but disabled when recaps are off", async () => {
    setup();
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Spoken recaps" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.getByText(/Each recap uses an extra model call/)).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Length threshold" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("switch", { name: "Create audio" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("combobox", { name: "Audio speed" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("saves the on switch and enables speed only after audio is enabled", async () => {
    setup();
    const master = screen.getByRole("switch", { name: "Spoken recaps" });
    await waitFor(() => expect(master.hasAttribute("disabled")).toBe(false));
    fireEvent.click(master);
    await waitFor(() => expect(master.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Create audio" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.getByRole("combobox", { name: "Audio speed" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Create audio" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Audio speed" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(fetchAppApi).toHaveBeenCalledWith(
      "settings",
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
    expect(screen.getByRole("switch", { name: "Create audio" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Audio speed" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("keeps the saved state and reports a failed write inline", async () => {
    setup(true, true);
    const master = screen.getByRole("switch", { name: "Spoken recaps" });
    await waitFor(() => expect(master.hasAttribute("disabled")).toBe(false));
    rs.mocked(fetchAppApi).mockResolvedValueOnce(new Response(null, { status: 500 }));
    fireEvent.click(master);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(master.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
