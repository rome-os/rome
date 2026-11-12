// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { SessionRenewalNotice } from "./SessionRenewalNotice";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function serve(handoff: string | null) {
  const requested: string[] = [];
  rs.stubGlobal(
    "fetch",
    rs.fn(async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify({ handoff }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return requested;
}

function renderNotice(renewal?: { chatId: string; sessionId: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionRenewalNotice reason="setup" renewal={renewal} />
    </QueryClientProvider>,
  );
}

describe("SessionRenewalNotice", () => {
  it("opens to the handoff the renewal wrote", async () => {
    const requested = serve("- Agreed: dinner on Friday.");
    renderNotice({ chatId: "chat-1", sessionId: "s-2" });
    const toggle = await screen.findByRole("button", { name: /Context tidied up · setup updated/ });
    expect(requested).toEqual(["/api/chat/sessions/chat-1/renewals/s-2"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Show summary");
    fireEvent.click(toggle);
    expect(screen.getByText("Summary carried over")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("- Agreed: dinner on Friday.")).toBeTruthy();
  });

  it("stays a plain line when the renewal wrote none", async () => {
    const requested = serve(null);
    renderNotice({ chatId: "chat-1", sessionId: "s-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("note").textContent).toBe("Context tidied up · setup updated");
  });

  it("reads nothing for a line that names no session", () => {
    const requested = serve("unused");
    renderNotice();
    expect(requested).toEqual([]);
    expect(screen.getByRole("note")).toBeTruthy();
  });
});
