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
  const later = (id: string, hours: number, extra: Partial<ChatPendingCheckDto> = {}) => ({
    id,
    name: id,
    at: Date.now() + hours * HOUR + 1_000,
    waitingFor: null,
    taskId: null,
    ...extra,
  });

  it("folds one check to a line that reads just that check", async () => {
    serve([later("CI run", 1)]);
    renderChecks();
    expect(await screen.findByText("CI run · in 1 hr")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("folds several to one line with the count and the soonest, and opens the list, soonest first", async () => {
    serve([
      later("Reply", 2, { waitingFor: "Dana's reply" }),
      later("CI run", 1),
      later("Weekly", 5),
    ]);
    const user = userEvent.setup();
    renderChecks();
    expect(await screen.findByText("3 checks · next: CI run · in 1 hr")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show scheduled checks" }));
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual([
      "CI run · in 1 hr",
      "Waiting for Dana's reply · checks in 2 hr",
      "Weekly · in 5 hr",
    ]);
    await user.click(screen.getByRole("button", { name: "Hide scheduled checks" }));
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("names the task a check is for", async () => {
    serve([later("PR 42 check-in", 23, { taskId: "t-1", taskTitle: "PR 42" }), later("CI run", 1)]);
    const user = userEvent.setup();
    renderChecks();
    await user.click(await screen.findByRole("button", { name: "Show scheduled checks" }));
    expect(screen.getByText("PR 42 · in 23 hr")).toBeTruthy();
  });

  it("cancels a check from the open list", async () => {
    const deleted = serve([
      later("ci", 1, { name: "CI run" }),
      later("reply", 2, { name: "Reply" }),
    ]);
    const user = userEvent.setup();
    renderChecks();
    await user.click(await screen.findByRole("button", { name: "Show scheduled checks" }));
    await user.click(screen.getByRole("button", { name: "Cancel CI run" }));
    await waitFor(() => expect(screen.queryByText("CI run · in 1 hr")).toBeNull());
    expect(deleted).toEqual(["ci"]);
  });

  it("drops a check from the strip once its time has passed", async () => {
    serve([
      { id: "soon", name: "Soon", at: Date.now() + 1_500, waitingFor: null, taskId: null },
      later("Later", 2),
    ]);
    renderChecks();
    expect(await screen.findByText(/^2 checks · next: Soon/)).toBeTruthy();
    expect(await screen.findByText("Later · in 2 hr", undefined, { timeout: 5_000 })).toBeTruthy();
  });

  it("counts a check's time from now, not from when the strip first showed", async () => {
    serve([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const at = (turnKey: boolean) => (
      <QueryClientProvider client={client}>
        <PendingChecks chatId="chat-1" turnKey={turnKey} />
      </QueryClientProvider>
    );
    const { rerender } = render(at(false));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // The chat stays open ten minutes before the agent schedules a check.
    const realNow = Date.now.bind(Date);
    rs.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60_000);
    serve([
      {
        id: "soon",
        name: "Soon",
        at: Date.now() + 5 * 60_000 + 1_000,
        waitingFor: null,
        taskId: null,
      },
    ]);
    rerender(at(true));
    expect(await screen.findByText("Soon · in 5 min")).toBeTruthy();
  });

  it("shows nothing when no check is pending", async () => {
    serve([]);
    const { container } = renderChecks();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
