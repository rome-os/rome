// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { type ReactNode, useEffect } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom";
import { toast } from "sonner";
import { DetailPane } from "@/components/connections/detail-pane";
import { Toaster } from "@/components/ui/sonner";
import { useSettingsBackdrop } from "@/hooks/use-settings-backdrop";
import i18n from "@/i18n";
import SettingsDialog from "./SettingsDialog";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

let navigateTo: NavigateFunction;

/** The app's two route trees, cut down: the page behind, and Settings over it. */
function Harness({ body }: { body: ReactNode }) {
  const location = useLocation();
  navigateTo = useNavigate();
  const { backdrop, settingsOpen, close } = useSettingsBackdrop();
  return (
    <>
      <output aria-label="location">
        {`${location.pathname}${location.search}${location.hash}`}
      </output>
      <output aria-label="state">{JSON.stringify(location.state)}</output>
      <Routes location={backdrop}>
        <Route path="*" element={<BehindPage />} />
      </Routes>
      {settingsOpen ? <SettingsDialog onClose={close}>{body}</SettingsDialog> : null}
    </>
  );
}

function BehindPage() {
  const { pathname, search } = useLocation();
  return <output aria-label="behind">{`${pathname}${search}`}</output>;
}

function renderDialog(
  path: string | { pathname: string; search?: string; hash?: string; state?: unknown },
  body: ReactNode = <p>Section</p>,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness body={body} />
    </MemoryRouter>,
  );
}

const read = (label: string) => screen.getByLabelText(label, { hidden: true }).textContent;
const location = () => read("location");

function Pane({ onClose }: { onClose: () => void }) {
  return (
    <DetailPane
      label="Telegram"
      backLabel="Connections"
      onClose={onClose}
      mark={null}
      status={null}
    >
      <p>Detail</p>
    </DetailPane>
  );
}

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

  it("labels its close button", () => {
    renderDialog("/settings/appearance");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("returns to the page behind, with its search, hash and state, when Escape closes it", () => {
    renderDialog({
      pathname: "/apps",
      search: "?tab=mine",
      hash: "#top",
      state: { from: "/people" },
    });
    act(() => navigateTo("/settings/advanced"));
    expect(read("behind")).toBe("/apps?tab=mine");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(location()).toBe("/apps?tab=mine#top");
    expect(read("state")).toBe(JSON.stringify({ from: "/people" }));
  });

  it("shows the main chat behind a fresh load and returns there", () => {
    renderDialog("/settings/advanced?hideSidebar=1");
    expect(read("behind")).toBe("/message?hideSidebar=1");
    act(() => navigateTo("/settings/appearance"));
    expect(read("behind")).toBe("/message?hideSidebar=1");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(location()).toBe("/message?hideSidebar=1");
  });

  it("steps an open detail pane back on Escape, wherever focus is", () => {
    const back = rs.fn();
    renderDialog("/settings/connections", <Pane onClose={back} />);
    screen.getByRole("link", { name: "Devices" }).focus();
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    expect(back).toHaveBeenCalledTimes(1);
    expect(location()).toBe("/settings/connections");
  });

  it("closes again once the detail pane is gone", () => {
    function Toggle() {
      const navigate = useNavigate();
      const { pathname } = useLocation();
      return pathname.endsWith("/telegram") ? (
        <Pane onClose={() => navigate("/settings/connections")} />
      ) : (
        <p>Grid</p>
      );
    }
    renderDialog("/apps", <Toggle />);
    act(() => navigateTo("/settings/connections/telegram"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(location()).toBe("/settings/connections");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(location()).toBe("/apps");
  });

  it("stays open when the guardian acts on a toast", async () => {
    const retry = rs.fn();
    function RaiseToast() {
      useEffect(() => {
        toast.error("Save failed", { action: { label: "Retry", onClick: retry } });
      }, []);
      return <p>Section</p>;
    }
    render(
      <MemoryRouter initialEntries={["/apps"]}>
        <Toaster />
        <Harness body={<RaiseToast />} />
      </MemoryRouter>,
    );
    act(() => navigateTo("/settings/appearance"));
    const action = await screen.findByRole("button", { name: "Retry" });
    // The open dialog turns pointer events off on the body, so the toaster has
    // to turn them back on for the action to receive the click at all.
    expect(action.closest<HTMLElement>("[data-sonner-toaster]")?.style.pointerEvents).toBe("auto");
    fireEvent.pointerDown(action);
    fireEvent.click(action);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(location()).toBe("/settings/appearance");
  });
});
