// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { ThemeProvider } from "@/hooks/use-theme";
import { AppComponentView } from "./AppComponentView";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderFailingCard(result?: Record<string, unknown>) {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: "App is disabled" }), { status: 404 }),
  );
  const onDismiss = rs.fn();
  render(
    <ThemeProvider>
      <AppComponentView
        toolUseId="tool-1"
        appId="some-app"
        componentId="name-card"
        result={result}
        onSubmit={() => {}}
        onDismiss={onDismiss}
      />
    </ThemeProvider>,
  );
  return onDismiss;
}

describe("AppComponentView", () => {
  it("lets the guardian dismiss a card that cannot load", async () => {
    const onDismiss = renderFailingCard();

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith("tool-1");
  });

  it("keeps a card that cannot load marked as waiting until it is dismissed", async () => {
    renderFailingCard();

    const alert = await screen.findByRole("alert");
    expect(alert.dataset.chatPendingCard).toBe("");
    expect(alert.tabIndex).toBe(-1);
  });

  it("offers no dismiss once the card has an answer", async () => {
    renderFailingCard({ dismissed: true });

    await screen.findByText(/App is disabled/);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByRole("alert").dataset.chatPendingCard).toBeUndefined();
  });

  it("never marks a widget as waiting", () => {
    rs.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));
    const { container } = render(
      <ThemeProvider>
        <AppComponentView toolUseId="w1" appId="meals" componentId="today" />
      </ThemeProvider>,
    );

    const card = container.querySelector("[data-ui-scale]") as HTMLElement;
    expect(card.dataset.chatPendingCard).toBeUndefined();
  });

  it("offers no dismiss on a widget that cannot load", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "App is disabled" }), { status: 404 }),
    );
    render(
      <ThemeProvider>
        <AppComponentView toolUseId="w1" appId="meals" componentId="today" />
      </ThemeProvider>,
    );

    await screen.findByText(/App is disabled/);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByRole("alert").dataset.chatPendingCard).toBeUndefined();
  });
});
