// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { listSessions } from "@/lib/chat-api";
import { emitSessionsChanged } from "@/lib/session-events";
import { useChatSessions } from "./use-chat-sessions";

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
