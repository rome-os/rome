// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import ConnectAccountPage from "./ConnectAccountPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.useRealTimers();
  rs.restoreAllMocks();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A code as the server gives it: `seconds` to live, and `expiresAt` on the
 *  server's clock, which this browser's clock need not match. */
const issued = (code: string, seconds: number, serverNow = Date.now()) =>
  json({
    code,
    expiresAt: new Date(serverNow + seconds * 1000).toISOString(),
    expiresInSeconds: seconds,
  });

function renderPage(...responses: Response[]) {
  const fetch = rs.spyOn(globalThis, "fetch");
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  render(
    <MemoryRouter initialEntries={["/connect-account"]}>
      <ConnectAccountPage />
    </MemoryRouter>,
  );
  return fetch;
}

const getCode = () => fireEvent.click(screen.getByRole("button", { name: "Get a code" }));

describe("ConnectAccountPage", () => {
  it("explains connecting and asks for nothing until the person asks for a code", () => {
    const fetch = renderPage();
    expect(screen.getByRole("heading", { name: "Connect an account" })).toBeTruthy();
    expect(screen.getByText(/so Rome knows its messages come from you/)).toBeTruthy();
    expect(screen.getByText("This code is yours alone")).toBeTruthy();
    expect(screen.getByText(/share it with nobody/)).toBeTruthy();
    expect(screen.queryByText("Your code")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the code, the time it has left, the steps, and copies it", async () => {
    const writeText = rs.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const fetch = renderPage(issued("ROME-ABCDEF-GHJKMN", 600));
    getCode();

    expect(await screen.findByText("ROME-ABCDEF-GHJKMN")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      "/api/account-codes",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(screen.getByText(/Stops working in (10:00|9:59)/)).toBeTruthy();
    expect(screen.getByText(/Open a direct message with Rome/)).toBeTruthy();
    expect(screen.getByText(/Send only the code/)).toBeTruthy();
    expect(screen.getByText(/Wait for Rome to answer/)).toBeTruthy();
    expect(screen.getByText(/A new code replaces this one/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith("ROME-ABCDEF-GHJKMN");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("shows a new code's full time on its first paint, however long the page was open", async () => {
    rs.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setInterval", "clearInterval", "performance"],
    });
    renderPage(issued("ROME-ABCDEF-GHJKMN", 600));
    await act(async () => {
      await rs.advanceTimersByTimeAsync(2 * 60_000);
    });
    getCode();
    expect(await screen.findByText("ROME-ABCDEF-GHJKMN")).toBeTruthy();
    expect(screen.getByText("Stops working in 10:00")).toBeTruthy();
  });

  it("shows a fresh code when the browser clock runs 15 minutes fast", async () => {
    const serverNow = Date.now();
    rs.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    rs.setSystemTime(serverNow + 15 * 60_000);
    renderPage(issued("ROME-ABCDEF-GHJKMN", 600, serverNow));
    getCode();
    expect(await screen.findByText("ROME-ABCDEF-GHJKMN")).toBeTruthy();
    expect(screen.getByText(/Stops working in (10:00|9:59)/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says the code expired once its time runs out, and gets a new one", async () => {
    rs.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setInterval", "clearInterval", "performance"],
    });
    renderPage(issued("ROME-ABCDEF-GHJKMN", 3), issued("ROME-PQRSTV-WXYZ23", 600));
    getCode();
    expect(await screen.findByText("ROME-ABCDEF-GHJKMN")).toBeTruthy();

    await act(async () => {
      await rs.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByRole("status").textContent).toBe("This code has expired.");
    expect(screen.queryByText("ROME-ABCDEF-GHJKMN")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Get a new code" }));
    expect(await screen.findByText("ROME-PQRSTV-WXYZ23")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a failed request failed, and lets the person ask again", async () => {
    renderPage(json({ error: "boom" }, 500), issued("ROME-ABCDEF-GHJKMN", 600));
    getCode();
    expect(await screen.findByText("Could not get a code")).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();

    getCode();
    expect(await screen.findByText("ROME-ABCDEF-GHJKMN")).toBeTruthy();
    expect(screen.queryByText("Could not get a code")).toBeNull();
  });

  it("tells a sign-in that belongs to nobody to ask the guardian", async () => {
    renderPage(json({ error: "This sign-in belongs to no person", code: "no_person" }, 403));
    getCode();
    expect(await screen.findByText("Could not get a code")).toBeTruthy();
    expect(screen.getByText(/Ask the guardian to invite your email/)).toBeTruthy();
  });

  it("gives only the failure for any other refusal", async () => {
    renderPage(json({ error: "Cross-site requests are not allowed." }, 403));
    getCode();
    expect(await screen.findByText("Could not get a code")).toBeTruthy();
    expect(screen.queryByText(/Ask the guardian/)).toBeNull();
    expect(screen.queryByText(/Cross-site/)).toBeNull();
  });
});
