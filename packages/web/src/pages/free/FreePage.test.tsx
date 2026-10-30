// @rstest-environment jsdom
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import FreePage, { ConciergePage } from "./FreePage";

const concierge = rs.hoisted(() => ({ enabled: true, settingsLoading: false }));

rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChat: () => ({
    chatId: concierge.enabled ? "concierge" : null,
    enabled: concierge.enabled,
    settingsLoading: concierge.settingsLoading,
    loading: concierge.settingsLoading,
  }),
}));

rs.mock("./FreeGrid", () => ({
  FreeGrid: (props: { sessionId?: string; active?: boolean }) => (
    <div data-testid="grid" data-session={props.sessionId} data-active={String(props.active)} />
  ),
}));

afterEach(() => {
  cleanup();
  concierge.enabled = true;
  concierge.settingsLoading = false;
});

const at = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <FreePage />
  </MemoryRouter>
);

describe("FreePage", () => {
  it("draws a chat's grid", () => {
    render(at("/chat/someone-else"));
    expect(screen.getByTestId("grid")).toBeTruthy();
  });

  it("leaves the Concierge's address to the page that is kept alive", () => {
    const view = render(at("/chat/concierge"));
    expect(screen.queryByTestId("grid")).toBeNull();
    view.unmount();

    // Its settings still loading, it is not yet known whose page this is.
    concierge.settingsLoading = true;
    render(at("/chat/concierge/anything"));
    expect(screen.queryByTestId("grid")).toBeNull();
  });

  it("draws the grid at the Concierge's address when Concierge is off", () => {
    concierge.enabled = false;
    render(at("/chat/concierge"));
    expect(screen.getByTestId("grid")).toBeTruthy();
  });
});

describe("ConciergePage", () => {
  it("pins the grid to the Concierge chat, shown or not", () => {
    const view = render(
      <MemoryRouter initialEntries={["/settings"]}>
        <ConciergePage active={false} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("grid").dataset.session).toBe("concierge");
    expect(screen.getByTestId("grid").dataset.active).toBe("false");

    view.rerender(
      <MemoryRouter initialEntries={["/settings"]}>
        <ConciergePage active />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("grid").dataset.active).toBe("true");
  });
});
