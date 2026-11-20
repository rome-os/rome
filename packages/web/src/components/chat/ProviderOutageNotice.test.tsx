// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  alternatives: ["openai"],
};

function renderNotice(part: Partial<ProviderOutagePart>, open = true) {
  const calls: { url: string; body: unknown }[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ moved: 2 });
    }
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
  return calls;
}

describe("ProviderOutageNotice", () => {
  it("lists the waiting tasks and moves them all with one switch", async () => {
    const calls = renderNotice({});
    expect(
      screen.getByText("Claude is unavailable for now. Rome tries again by itself."),
    ).toBeTruthy();
    expect(screen.getByText("2 tasks waiting")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Switch to ChatGPT" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("The 2 affected tasks continue on ChatGPT.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Also make default" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          url: "/api/ai-tools/provider-outages/o1/switch",
          body: { kind: "provider", provider: "openai", makeDefault: true },
        },
      ]),
    );
    expect(await screen.findByText("Switched to ChatGPT")).toBeTruthy();
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
