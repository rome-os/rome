// @rstest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { LiveEventsClientContext } from "./use-live-events";
import {
  acceptLatestSocket,
  FakeWebSocket,
  fakeSocketLiveEventsClient,
} from "@/test/fake-websocket";
import { useAiToolStatus } from "./use-ai-tool-status";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  FakeWebSocket.instances = [];
});

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const live = fakeSocketLiveEventsClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <LiveEventsClientContext.Provider value={live}>{children}</LiveEventsClientContext.Provider>
    </QueryClientProvider>
  );
  return { wrapper, queryClient };
}

const push = (socket: FakeWebSocket, data: unknown) =>
  socket.receive({ type: "event", topic: "ai-tools.status", event: "status", data });

describe("useAiToolStatus", () => {
  it("shares one seed GET and wire subscription, then updates all readers from a push", async () => {
    const fetch = rs
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ claude: { loggedIn: true } }));
    const { wrapper } = setup();
    const readers = renderHook(() => [useAiToolStatus(), useAiToolStatus()], { wrapper });
    await waitFor(() => expect(readers.result.current[0].data?.claude?.loggedIn).toBe(true));
    let socket!: FakeWebSocket;
    act(() => {
      socket = acceptLatestSocket();
    });
    expect(socket.sent).toEqual([{ type: "subscribe", topic: "ai-tools.status" }]);
    const status = {
      claude: {
        loggedIn: true,
        usage: {
          checkedAt: "2026-10-29T00:00:00Z",
          source: "event",
          fiveHour: { usedPercent: 29 },
        },
      },
    };
    await act(async () => push(socket, status));
    await waitFor(() =>
      expect(readers.result.current.map((q) => q.data)).toEqual([status, status]),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not let an older GET overwrite a push, ignores malformed pushes, and replays after reconnect", async () => {
    let resolve!: (response: Response) => void;
    rs.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { wrapper } = setup();
    const reader = renderHook(() => useAiToolStatus(), { wrapper });
    let socket!: FakeWebSocket;
    act(() => {
      socket = acceptLatestSocket();
    });
    await act(async () => push(socket, { claude: { loggedIn: true } }));
    await act(async () => resolve(Response.json({ claude: { loggedIn: false } })));
    expect(reader.result.current.data?.claude?.loggedIn).toBe(true);
    const error = rs.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => push(socket, { claude: { loggedIn: "garbage" } }));
    expect(error).toHaveBeenCalled();
    expect(reader.result.current.data?.claude?.loggedIn).toBe(true);
    act(() => socket.close());
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    act(() => {
      socket = acceptLatestSocket();
    });
    await act(async () => push(socket, { claude: { loggedIn: false } }));
    await waitFor(() => expect(reader.result.current.data?.claude?.loggedIn).toBe(false));
  });

  it("polls only while login detection is active", async () => {
    const fetch = rs
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ codex: { loggedIn: false } }));
    const { wrapper } = setup();
    const reader = renderHook(({ polling }) => useAiToolStatus({ loginPolling: polling }), {
      wrapper,
      initialProps: { polling: true },
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 3000 });
    reader.rerender({ polling: false });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
