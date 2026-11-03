// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CHAT_SESSIONS_CHANGED_EVENT } from "@/lib/session-events";
import { useResolveApproval } from "./use-approvals";

const mockFetchJson = rs.hoisted(() => rs.fn());
rs.mock("@/lib/fetch-json", () => ({ fetchJson: mockFetchJson }));

afterEach(cleanup);

describe("useResolveApproval", () => {
  it("tells the sidebar to refresh once an approval is resolved", async () => {
    mockFetchJson.mockResolvedValue({ ok: true });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const changed = rs.fn();
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, changed);
    try {
      const { result } = renderHook(() => useResolveApproval(), { wrapper });
      await act(() => result.current.mutateAsync({ id: "appr-1", action: "reject" }));
      expect(changed).toHaveBeenCalled();
    } finally {
      window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, changed);
    }
  });
});
