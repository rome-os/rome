// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { ProviderOutagePart } from "@rome/api-types/chat";
import i18n from "@/i18n";
import { ProviderOutageNotice } from "./ProviderOutageNotice";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const OUTAGE: ProviderOutagePart = {
  type: "provider_outage",
  outageId: "o1",
  provider: "anthropic",
  reason: "temporary",
  card: "wait",
  chatIds: ["t1", "t2"],
};

function renderNotice(part: Partial<ProviderOutagePart>, open = true) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    const url = String(input);
    if (url === "/api/ai-tools/provider-outages") {
      return Response.json({
        outages: open
          ? [
              {
                id: "o1",
                provider: "anthropic",
                reason: "temporary",
                chatIds: ["t1", "t2"],
                since: "",
              },
            ]
          : [],
      });
    }
    return Response.json({});
  }) as typeof fetch);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProviderOutageNotice part={{ ...OUTAGE, ...part }} />
    </QueryClientProvider>,
  );
}

describe("ProviderOutageNotice", () => {
  it("lists the waiting tasks and offers no buttons: each task's own card acts", () => {
    renderNotice({});
    expect(
      screen.getByText("Claude is unavailable for now. Rome tries again by itself."),
    ).toBeTruthy();
    expect(screen.getByText("2 tasks waiting")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Switch|Log in|Use Rome credits/ })).toBeNull();
  });

  it("reads as one line once settled", () => {
    renderNotice({
      resolved: { at: "2026-08-08T10:00:00.000Z", by: "recovered" },
      resolvedAt: "2026-08-08T10:00:00.000Z",
    });
    expect(screen.getByText("Recovered")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads as recovered once its outage is no longer open", async () => {
    renderNotice({}, false);
    expect(await screen.findByText("Recovered")).toBeTruthy();
  });
});
