// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatSession } from "@/lib/chat-types";
import { emitSessionsChanged } from "@/lib/session-events";
import { useSessionNames } from "./use-session-names";

rs.mock("@/lib/chat-api", () => ({
  getSession: rs.fn(),
}));

import { getSession } from "@/lib/chat-api";

function session(id: string, name: string): ChatSession {
  return {
    id,
    name,
    personaId: null,
    projectName: "default",
    agentName: null,
    archivedAt: null,
    pinnedAt: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    activityAt: "2026-10-11T00:00:00.000Z",
    lastSeenActivityAt: null,
    unread: false,
    messageCount: 2,
  };
}

describe("useSessionNames", () => {
  afterEach(() => {
    rs.mocked(getSession).mockReset();
  });

  it("names each session, leaving unnamed and missing ones out", async () => {
    const stored: Record<string, ChatSession> = {
      s1: session("s1", "Weekly report"),
      s2: session("s2", "  "),
    };
    rs.mocked(getSession).mockImplementation(async (id) => stored[id] ?? null);

    const { result } = renderHook(() => useSessionNames(["s1", "s2", "gone"]));

    await waitFor(() => expect(result.current.get("s1")).toBe("Weekly report"));
    expect(result.current.has("s2")).toBe(false);
    expect(result.current.has("gone")).toBe(false);
  });

  it("re-reads names when a session changes, and keeps a name a failed read cannot replace", async () => {
    let name = "Untitled draft";
    rs.mocked(getSession).mockImplementation(async (id) => session(id, name));
    const { result } = renderHook(() => useSessionNames(["s1"]));
    await waitFor(() => expect(result.current.get("s1")).toBe("Untitled draft"));

    name = "Trip planning";
    act(() => emitSessionsChanged());
    await waitFor(() => expect(result.current.get("s1")).toBe("Trip planning"));

    rs.mocked(getSession).mockRejectedValue(new Error("offline"));
    act(() => emitSessionsChanged());
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(3));
    // Let the rejected read settle before checking the name survived it.
    await act(async () => {});
    expect(result.current.get("s1")).toBe("Trip planning");
  });
});
