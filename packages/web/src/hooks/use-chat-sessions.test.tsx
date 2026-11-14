// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { listSessions } from "@/lib/chat-api";
import { emitSessionsChanged } from "@/lib/session-events";
import { useChatSession, useChatSessions } from "./use-chat-sessions";

rs.mock("@/lib/chat-api", () => ({ listSessions: rs.fn() }));

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useChatSessions", () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rs.mocked(listSessions).mockReset();
    rs.mocked(listSessions).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it("reuses the list for a remount, and does not refetch it when the tab comes back", async () => {
    const wrapper = wrapperFor(client);
    const first = renderHook(() => useChatSessions("active", "all"), { wrapper });
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    first.unmount();
    renderHook(() => useChatSessions("active", "all"), { wrapper });
    // React Query reads focus from `visibilitychange` on the window.
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("reads one chat from the sidebar's list, fetching every chat only when no list holds it", async () => {
    const chat = (id: string) => ({ id, name: id }) as never;
    rs.mocked(listSessions).mockImplementation(async (status) =>
      status === "active" ? [chat("open")] : [chat("open"), chat("archived")],
    );
    const wrapper = wrapperFor(client);
    renderHook(() => useChatSessions("active", "all"), { wrapper });
    const cards = [0, 1, 2].map(() => renderHook(() => useChatSession("open"), { wrapper }));
    await waitFor(() => expect(cards[0]?.result.current.session).toMatchObject({ id: "open" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rs.mocked(listSessions).mock.calls.map((call) => call[0])).toEqual(["active"]);

    const archived = renderHook(() => useChatSession("archived"), { wrapper });
    await waitFor(() => expect(archived.result.current.session).toMatchObject({ id: "archived" }));
    expect(rs.mocked(listSessions).mock.calls.map((call) => call[0])).toEqual(["active", "all"]);
  });

  it("reads its own list once the sidebar's is no longer on screen, as that one goes stale", async () => {
    rs.mocked(listSessions).mockImplementation(async () => [
      { id: "open", name: "open", awaitingGuardian: true } as never,
    ]);
    const wrapper = wrapperFor(client);
    const sidebar = renderHook(() => useChatSessions("active", "all"), { wrapper });
    const card = renderHook(() => useChatSession("open"), { wrapper });
    await waitFor(() => expect(card.result.current.session).toMatchObject({ id: "open" }));
    expect(rs.mocked(listSessions).mock.calls.map((call) => call[0])).toEqual(["active"]);

    sidebar.unmount();
    await waitFor(() =>
      expect(rs.mocked(listSessions).mock.calls.map((call) => call[0])).toEqual(["active", "all"]),
    );
    // An event now refetches the card's own list, which it reads.
    rs.mocked(listSessions).mockImplementation(async () => [
      { id: "open", name: "open", awaitingGuardian: false } as never,
    ]);
    act(() => emitSessionsChanged());
    await waitFor(() =>
      expect(card.result.current.session).toMatchObject({ awaitingGuardian: false }),
    );
  });

  it("refetches once when many consumers share one sessions-changed event", async () => {
    const wrapper = wrapperFor(client);
    for (let i = 0; i < 12; i += 1) renderHook(() => useChatSessions("all", "all"), { wrapper });
    renderHook(() => useChatSessions("active", "all"), { wrapper });
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    rs.mocked(listSessions).mockClear();

    act(() => emitSessionsChanged());

    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(rs.mocked(listSessions).mock.calls.map((call) => call.slice(0, 2))).toEqual(
      expect.arrayContaining([
        ["all", "all"],
        ["active", "all"],
      ]),
    );
  });

  it("shares one invalidation between events fired in the same tick", async () => {
    const wrapper = wrapperFor(client);
    renderHook(() => useChatSessions("active", "all"), { wrapper });
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    act(() => {
      emitSessionsChanged();
      emitSessionsChanged();
      emitSessionsChanged();
    });

    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("stops listening once the last consumer unmounts", async () => {
    const wrapper = wrapperFor(client);
    const first = renderHook(() => useChatSessions("active", "all"), { wrapper });
    const second = renderHook(() => useChatSessions("all", "all"), { wrapper });
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    first.unmount();
    second.unmount();
    rs.mocked(listSessions).mockClear();

    act(() => emitSessionsChanged());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(listSessions).not.toHaveBeenCalled();
  });

  it("passes an abort signal so a superseded request can be cancelled", async () => {
    renderHook(() => useChatSessions("active", "all"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    expect(rs.mocked(listSessions).mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });
});
