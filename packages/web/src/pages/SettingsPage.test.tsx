// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "@rstest/core";
import SettingsPage from "./SettingsPage";

afterEach(cleanup);

function Location() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

describe("SettingsPage", () => {
  it("keeps the query string, including hidden-sidebar mode, through its redirect", () => {
    render(
      <MemoryRouter initialEntries={["/settings?hideSidebar=1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:tab" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("location").textContent).toBe("/settings/appearance?hideSidebar=1");
  });
});
