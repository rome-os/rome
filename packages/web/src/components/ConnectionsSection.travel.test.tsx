// @rstest-environment jsdom
// Its own file: after another test renders in the same file, motion starts no
// layout animation in jsdom.
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { ConnectionsSection } from "@/components/ConnectionsSection";
import type { ApiConnection, GrantState } from "@/lib/connections-api";
import { stateOfGrants } from "@/test/connection-state";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function oauth(service: "github" | "google" | "slack", state: GrantState): ApiConnection {
  const grant = service === "slack" ? "workspace" : "user";
  return {
    id: `conn-${service}`,
    label: service,
    connectionKind: service,
    state: stateOfGrants({ [grant]: state }),
    grants: { [grant]: state },
    display: { [grant]: null },
    capabilities: {
      chat: { state: "unsupported" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: { url: `https://oauth/${service}`, available: true, unavailableReason: null },
    setups: {},
    channel: null,
    agent: null,
    severalAccounts: false,
  };
}

function section(google: GrantState) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ConnectionsSection
          connections={[
            oauth("github", "authorized"),
            oauth("slack", "unauthorized"),
            oauth("google", google),
          ]}
          composio={null}
          loading={false}
          error={null}
          onRefresh={async () => null}
          onFlash={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const slotOf = (name: string) =>
  screen.getByRole("button", { name: `Open ${name}` }).closest("[data-card-slot]") as HTMLElement;

describe("ConnectionsSection — card travel", () => {
  it("stops a card's travel when a search starts mid-travel", async () => {
    // jsdom lays nothing out, so place each card one row below the last.
    rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const slots = [...document.querySelectorAll("[data-card-slot]")];
      return DOMRect.fromRect({
        y: Math.max(slots.indexOf(this), 0) * 100,
        width: 300,
        height: 60,
      });
    });
    const { rerender } = render(section("unauthorized"));
    rerender(section("authorized"));
    await waitFor(() => expect(slotOf("Google").style.transform).toMatch(/translate/));
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "google" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slotOf("Google").style.transform).not.toMatch(/translate/);
  });
});
