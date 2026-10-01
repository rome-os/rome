// @rstest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { RoutineCreatedCard } from "./RoutineCreatedCard";
import i18n from "@/i18n";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

// The card is always mounted inside the app's QueryClientProvider (its detail
// link primes the routines cache before navigating). Mirror that context so the
// standalone test renders the same component tree the transcript does.
function renderCard(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RoutineCreatedCard", () => {
  it("links to the exact persisted routine", () => {
    renderCard(<RoutineCreatedCard routineId="routine/new id" routineName="Landlord emails" />);

    expect(screen.getByText("Routine created: Landlord emails.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Run history" }).getAttribute("href")).toBe(
      "/routines/routine%2Fnew%20id",
    );
  });

  it("localizes the persisted completion UI", async () => {
    await i18n.changeLanguage("zh-CN");
    renderCard(<RoutineCreatedCard routineId="routine-1" routineName="每周提醒" />);

    expect(screen.getByText("已创建例程：每周提醒。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "运行历史" }).getAttribute("href")).toBe(
      "/routines/routine-1",
    );
  });
});
