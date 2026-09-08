// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AgentCatalogGroup, ChatSession } from "@/lib/chat-types";
import { emitSessionsChanged } from "@/lib/session-events";
import { setPresentationMode } from "@/lib/presentation-mode";
import { useSessionIdentity } from "./use-session-identity";

rs.mock("@/lib/chat-api", () => ({
  getSession: rs.fn(),
  listChatAgents: rs.fn(),
}));

import { getSession, listChatAgents } from "@/lib/chat-api";

const session: ChatSession = {
  id: "s1",
  name: "Planning the launch",
  personaId: null,
  projectName: "default",
  agentName: "replay",
  archivedAt: null,
  pinnedAt: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  activityAt: "2026-08-11T00:00:00.000Z",
  lastSeenActivityAt: null,
  unread: false,
  messageCount: 2,
};

const groups: AgentCatalogGroup[] = [
  {
    ownerId: "replay",
    ownerType: "app",
    label: "Replay",
    description: "",
    iconUrl: "/api/apps/replay/icon",
    agents: [{ name: "replay", description: "" }],
  },
];

afterEach(() => {
  window.localStorage.clear();
  rs.clearAllMocks();
});

describe("useSessionIdentity presentation mode", () => {
  it("masks the pinned-agent mention while presentation mode is on, and restores it when off", async () => {
    rs.mocked(getSession).mockResolvedValue(session);
    rs.mocked(listChatAgents).mockResolvedValue(groups);

    const { result } = renderHook(() => useSessionIdentity("s1"));
    await waitFor(() => expect(result.current.pinnedAgentMention?.appLabel).toBe("Replay"));
    expect(result.current.sessionName).toBe("Planning the launch");

    act(() => setPresentationMode(true));
    // The mask hides the agent identity only — the session name (the natural,
    // auto-generated title) must stay so headers still have a label.
    expect(result.current.pinnedAgentMention).toBeNull();
    expect(result.current.sessionName).toBe("Planning the launch");

    // Purely a rendering mask: toggling off restores the mention without a refetch.
    act(() => setPresentationMode(false));
    expect(result.current.pinnedAgentMention?.appLabel).toBe("Replay");
    expect(rs.mocked(getSession)).toHaveBeenCalledTimes(1);
  });

  it("resolves as masked when presentation mode was already on at mount", async () => {
    setPresentationMode(true);
    rs.mocked(getSession).mockResolvedValue(session);
    rs.mocked(listChatAgents).mockResolvedValue(groups);

    const { result } = renderHook(() => useSessionIdentity("s1"));
    await waitFor(() => expect(result.current.sessionName).toBe("Planning the launch"));
    expect(result.current.pinnedAgentMention).toBeNull();
  });
});

describe("useSessionIdentity model", () => {
  it("shows the actual model rather than the requested selection and refreshes it", async () => {
    rs.mocked(getSession).mockResolvedValue({
      ...session,
      largeModelSelection: "auto",
      model: "gpt-5.5",
    });
    rs.mocked(listChatAgents).mockResolvedValue(groups);
    const { result } = renderHook(() => useSessionIdentity("s1"));
    await waitFor(() => expect(result.current.model).toBe("gpt-5.5"));
    rs.mocked(getSession).mockResolvedValue({ ...session, model: "claude-opus-4-6" });
    act(() => emitSessionsChanged());
    await waitFor(() => expect(result.current.model).toBe("claude-opus-4-6"));
  });

  it("clears the model when navigating to a session without a pin", async () => {
    rs.mocked(getSession).mockResolvedValue({ ...session, model: "gpt-5.5" });
    rs.mocked(listChatAgents).mockResolvedValue(groups);
    const { result, rerender } = renderHook(({ id }) => useSessionIdentity(id), {
      initialProps: { id: "s1" },
    });
    await waitFor(() => expect(result.current.model).toBe("gpt-5.5"));
    rs.mocked(getSession).mockResolvedValue({ ...session, id: "s2" });
    rerender({ id: "s2" });
    await waitFor(() => expect(result.current.model).toBeNull());
  });
});

it("ignores an old session's pending model refresh after navigation", async () => {
  rs.mocked(getSession).mockResolvedValue({ ...session, model: "gpt-5.5" });
  rs.mocked(listChatAgents).mockResolvedValue(groups);
  const { result, rerender } = renderHook(({ id }) => useSessionIdentity(id), {
    initialProps: { id: "s1" },
  });
  await waitFor(() => expect(result.current.model).toBe("gpt-5.5"));
  let finishRefresh!: (session: ChatSession) => void;
  rs.mocked(getSession).mockReturnValueOnce(
    new Promise((resolve) => {
      finishRefresh = resolve;
    }),
  );
  act(() => emitSessionsChanged());
  rs.mocked(getSession).mockResolvedValue({ ...session, id: "s2", model: "claude-opus-4-6" });
  rerender({ id: "s2" });
  await waitFor(() => expect(result.current.model).toBe("claude-opus-4-6"));
  await act(async () => finishRefresh({ ...session, model: "gpt-5.5" }));
  expect(result.current.model).toBe("claude-opus-4-6");
});
