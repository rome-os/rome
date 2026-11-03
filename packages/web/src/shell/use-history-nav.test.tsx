// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, Link } from "react-router-dom";
import { useHistoryNav } from "./use-history-nav";

function Probe() {
  const { canGoBack, canGoForward, back, forward } = useHistoryNav();
  return (
    <div>
      <output data-testid="nav">{`back:${canGoBack} forward:${canGoForward}`}</output>
      <button type="button" onClick={back}>
        Back
      </button>
      <button type="button" onClick={forward}>
        Forward
      </button>
      <Link to="/a">A</Link>
      <Link to="/b">B</Link>
    </div>
  );
}

function renderProbe() {
  render(
    <BrowserRouter>
      <Probe />
    </BrowserRouter>,
  );
}

const nav = () => screen.getByTestId("nav").textContent;

beforeEach(() => {
  // Each test starts a fresh router session: with no index on the entry, the
  // router numbers it 0.
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

describe("useHistoryNav", () => {
  it("opens nothing on the session's first page", () => {
    renderProbe();
    expect(nav()).toBe("back:false forward:false");
  });

  it("opens back after a navigation, and forward after going back", async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole("link", { name: "A" }));
    expect(nav()).toBe("back:true forward:false");

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(nav()).toBe("back:false forward:true"));
    expect(window.location.pathname).toBe("/");

    await user.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(nav()).toBe("back:true forward:false"));
    expect(window.location.pathname).toBe("/a");
  });

  it("drops forward when a new page is opened after going back", async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole("link", { name: "A" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(nav()).toBe("back:false forward:true"));

    await user.click(screen.getByRole("link", { name: "B" }));
    expect(nav()).toBe("back:true forward:false");
  });
});
