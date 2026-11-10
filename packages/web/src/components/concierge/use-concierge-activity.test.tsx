// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { CONCIERGE_ACTIVITY_TOPIC } from "@rome/api-types/live-events";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import { useConciergeActivity } from "./use-concierge-activity";

// The header reads what core tells: the chats list's `activity` first, then
// the `concierge.activity` topic's events for the chat.

let listed: ConciergeActivity | undefined;

beforeEach(() => {
  FakeWebSocket.instances = [];
  listed = { kind: "tasks", title: "Book the flight", more: 0 };
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) =>
    String(input).startsWith("/api/concierge/chats")
      ? Response.json({
          chats: [
            { id: "main", name: "Concierge", main: true, unread: 0, activity: listed },
            { id: "topic", name: "Calendar", main: false, unread: 0 },
            // A kind from a newer server: the list still loads.
            {
              id: "newer",
              name: "Trip",
              main: false,
              unread: 0,
              activity: { kind: "dreaming" },
            },
          ],
        })
      : new Response("not found", { status: 404 })) as typeof fetch);
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </LiveEventsClientContext.Provider>
  );
}

const event = (chatId: string, activity: unknown) => ({
  type: "event",
  topic: CONCIERGE_ACTIVITY_TOPIC,
  event: "concierge_activity",
  data: { chatId, activity, at: 1 },
});

describe("useConciergeActivity", () => {
  it("starts from the chats list, then follows the chat's live events", async () => {
    const { result } = renderHook(() => useConciergeActivity("main"), { wrapper });
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "tasks", title: "Book the flight", more: 0 }),
    );
    const socket = acceptLatestSocket();
    act(() => socket.receive(event("main", { kind: "tool", tool: "startingTask" })));
    expect(result.current).toEqual({ kind: "tool", tool: "startingTask" });
    // Another chat's event leaves it alone.
    act(() => socket.receive(event("topic", { kind: "needsYou" })));
    expect(result.current).toEqual({ kind: "tool", tool: "startingTask" });
  });

  it("is idle for a chat the list carries no activity for, and drops a kind it does not know", async () => {
    const { result } = renderHook(() => useConciergeActivity("topic"), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ kind: "idle" }));
    const socket = acceptLatestSocket();
    act(() => socket.receive(event("topic", { kind: "dreaming" })));
    expect(result.current).toEqual({ kind: "idle" });
    act(() => socket.receive(event("topic", { kind: "working" })));
    expect(result.current).toEqual({ kind: "working" });
  });

  it("reads a tool it does not know as plain work", async () => {
    const { result } = renderHook(() => useConciergeActivity("main"), { wrapper });
    await waitFor(() => expect(result.current.kind).toBe("tasks"));
    const socket = acceptLatestSocket();
    act(() => socket.receive(event("main", { kind: "tool", tool: "paintingMural" })));
    expect(result.current).toEqual({ kind: "working" });
  });

  it("loads a list whose chat carries a kind it does not know, and reads that chat as idle", async () => {
    const main = renderHook(() => useConciergeActivity("main"), { wrapper });
    await waitFor(() =>
      expect(main.result.current).toEqual({ kind: "tasks", title: "Book the flight", more: 0 }),
    );
    const newer = renderHook(() => useConciergeActivity("newer"), { wrapper });
    await waitFor(() => expect(newer.result.current).toEqual({ kind: "idle" }));
  });

  it("is idle outside a Concierge chat and subscribes to nothing", () => {
    const { result } = renderHook(() => useConciergeActivity(null), { wrapper });
    expect(result.current).toEqual({ kind: "idle" });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
