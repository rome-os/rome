// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { DetailPane } from "@/components/connections/detail-pane";
import i18n from "@/i18n";
import SettingsDialog from "./SettingsDialog";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

function Where() {
  return <output aria-label="location">{useLocation().pathname}</output>;
}

function renderDialog(path: string, body = <p>Section</p>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route
          path="/settings/*"
          element={<SettingsDialog closeTo="/apps">{body}</SettingsDialog>}
        />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

const location = () => screen.getByLabelText("location", { hidden: true }).textContent;

describe("SettingsDialog", () => {
  it("names the section the guardian is in", () => {
    renderDialog("/settings/connections");
    expect(screen.getByRole("link", { name: "Connections" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe(
      "/settings/devices",
    );
  });

  it("keeps the section marked while a view is drilled into", () => {
    renderDialog("/settings/connections/telegram");
    expect(screen.getByRole("link", { name: "Connections" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("returns to the page behind when Escape closes it", () => {
    renderDialog("/settings/appearance");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(location()).toBe("/apps");
  });

  it("leaves Escape to an open detail pane", () => {
    renderDialog(
      "/settings/connections",
      <DetailPane
        label="Telegram"
        backLabel="Connections"
        onClose={() => {}}
        mark={null}
        status={null}
      >
        <p>Detail</p>
      </DetailPane>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(location()).toBe("/settings/connections");
  });
});
