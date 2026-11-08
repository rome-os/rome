// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { useConciergeName } from "./use-concierge";

function Name() {
  return <output>{useConciergeName()}</output>;
}

function renderName(settings: Record<string, unknown>) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(settings)) as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Name />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("useConciergeName", () => {
  it("is the trimmed agent name the guardian chose", async () => {
    renderName({ agentName: "  Milo " });
    expect(await screen.findByText("Milo")).toBeTruthy();
  });

  it.each([
    ["unset", {}],
    ["blank", { agentName: "   " }],
    ["not text", { agentName: 7 }],
  ])("falls back to Concierge when the agent name is %s", async (_label, settings) => {
    renderName(settings);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("status").textContent).toBe("Concierge");
  });
});
