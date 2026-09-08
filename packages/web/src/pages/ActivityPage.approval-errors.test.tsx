// @rstest-environment jsdom
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import ActivityPage from "./ActivityPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

it.each([403, 409, 500])("shows approval HTTP %s errors and allows retry", async (status) => {
  let failed = true;
  const attempts = rs.fn();
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/resolve")) {
      attempts();
      return Response.json(failed ? { error: "rejected" } : { ok: true }, {
        status: failed ? status : 202,
      });
    }
    return Response.json(
      url === "/api/approvals"
        ? [
            {
              id: "approval",
              type: "action_execution",
              status: "pending",
              requestedBy: "test",
              description: "Approval needing a decision",
              createdAt: new Date().toISOString(),
              resolvedAt: null,
              resolvedBy: null,
              payload: null,
            },
          ]
        : [],
    );
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ActivityPage />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Approve", exact: true }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not resolve the approval. Refresh and try again.",
  );
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Approve", exact: true }));
  await waitFor(() => expect(attempts).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
  client.clear();
});
