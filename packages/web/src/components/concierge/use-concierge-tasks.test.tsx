// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { CONCIERGE_TASKS_TOPIC } from "@rome/api-types/live-events";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { useConciergeTasks } from "./use-concierge-tasks";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const row = (extra: Record<string, unknown> = {}) => ({
  id: "task-1",
  title: "Draft",
  state: "needs_user",
  status: "needs_you",
  endReason: null,
  summary: null,
  waitingOn: null,
  dueAt: null,
  rank: null,
  chat: { id: "task-chat", name: "Draft" },
  conciergeChat: { id: "concierge", name: "Concierge", main: true },
  sourceMessageId: null,
  createdAt: 1,
  updatedAt: 2,
  completedAt: null,
  archivedAt: null,
  notSynced: false,
  ...extra,
});

describe("useConciergeTasks", () => {
  it("keeps what a task waits on through a live update, as the list read gave it", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ tasks: [row()] }));
    const seen: unknown[] = [];
    function Probe() {
      const { tasks } = useConciergeTasks({ allDone: true });
      seen.push(tasks[0]?.openWait);
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (node: ReactNode) => (
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </LiveEventsClientContext.Provider>
    );
    render(wrap(<Probe />));
    let socket!: ReturnType<typeof acceptLatestSocket>;
    act(() => {
      socket = acceptLatestSocket();
    });
    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    const openWait = {
      kind: "card",
      id: "tool-1",
      messageId: "m1",
      render: { componentId: "question-card" },
      since: 5,
    };
    act(() =>
      socket.receive({
        type: "event",
        topic: CONCIERGE_TASKS_TOPIC,
        event: "task_upsert",
        data: { task: row({ updatedAt: 3, openWait }) },
      }),
    );
    await waitFor(() => expect(seen.at(-1)).toEqual(openWait));
  });
});
