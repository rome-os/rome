// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatPendingCheckDto } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { PendingChecks } from "./PendingChecks";

const HOUR = 3_600_000;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function serve(checks: ChatPendingCheckDto[]) {
  const deleted: string[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      const id = url.split("/").pop() ?? "";
      deleted.push(id);
      checks = checks.filter((check) => check.id !== id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ checks }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return deleted;
}

const renderChecks = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PendingChecks chatId="chat-1" turnKey={false} />
    </QueryClientProvider>,
  );

describe("PendingChecks", () => {
  it("shows each check pending in the chat, and cancels one there", async () => {
    const deleted = serve([
      { id: "r-1", name: "CI run", at: Date.now() + HOUR + 1_000, waitingFor: null, taskId: "t-1" },
      {
        id: "r-2",
        name: "Reply",
        at: Date.now() + 2 * HOUR + 1_000,
        waitingFor: "Dana's reply",
        taskId: null,
      },
    ]);
    const user = userEvent.setup();
    renderChecks();
    expect(await screen.findByText("CI run · in 1 hr")).toBeTruthy();
    expect(screen.getByText("Waiting for Dana's reply · checks in 2 hr")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel CI run" }));
    await waitFor(() => expect(screen.queryByText("CI run · in 1 hr")).toBeNull());
    expect(deleted).toEqual(["r-1"]);
  });

  it("offers to skip the next run of a task's schedule, not to cancel it", async () => {
    const deleted = serve([
      {
        id: "r-3",
        name: "Daily summary",
        at: Date.now() + HOUR + 1_000,
        waitingFor: null,
        taskId: "t-2",
        recurring: true,
      },
    ]);
    const user = userEvent.setup();
    renderChecks();
    expect(await screen.findByText("Daily summary · in 1 hr")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel Daily summary" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Skip the next run of Daily summary" }));
    await waitFor(() => expect(deleted).toEqual(["r-3"]));
  });

  it("shows nothing when no check is pending", async () => {
    serve([]);
    const { container } = renderChecks();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
