// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import type { ChatMessage } from "@/lib/chat-types";
import { deleteSession } from "@/lib/chat-api";
import { chatTranscriptCache } from "@/lib/chat-transcript-cache";
import { ChatTranscriptCacheContext } from "@/lib/chat-transcript-cache-context";
import { FreeGrid } from "./FreeGrid";

const transcriptCacheContext = "https://rome.test|guardian:guardian-1";

rs.mock("@/lib/chat-api", () => ({
  deleteSession: rs.fn(),
}));

rs.mock("@/hooks/use-apps", () => ({
  useApps: () => ({ apps: [] }),
}));

rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: () => ({
    sessionName: "Cached chat",
    model: null,
    pinnedAgentMention: null,
    pinnedAt: null,
  }),
}));

rs.mock("@/hooks/use-document-title", () => ({ useDocumentTitle: () => {} }));

rs.mock("@/lib/session-events", () => ({
  emitSessionsChanged: rs.fn(),
  usePinSession: () => rs.fn(),
}));

rs.mock("@/components/slot", () => ({
  SlotContent: ({ children }: { children: ReactNode }) => children,
}));

rs.mock("./ChatWidget", () => ({ ChatWidget: () => null }));
rs.mock("./ToolWorkspace", () => ({
  ToolWorkspace: ({ children }: { children: ReactNode }) => children,
}));

rs.mock("./use-free-cells", () => ({
  autoPlaceApp: rs.fn(),
  autoPlaceProjects: rs.fn(),
  loadLayoutForSession: rs.fn().mockResolvedValue(undefined),
  placeWidgetsIfSessionActive: rs.fn(),
  setActiveSession: rs.fn(),
  updatePlacementLink: rs.fn(),
  useFreeCells: () => ({
    placements: [],
    addWidget: rs.fn(),
    removeWidget: rs.fn(),
    toolView: { activeId: null, collapsed: true, unreadIds: [] },
    selectTool: rs.fn(),
    setToolsCollapsed: rs.fn(),
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  rs.mocked(deleteSession).mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  cleanup();
  chatTranscriptCache.clear();
  rs.clearAllMocks();
});

describe("FreeGrid mobile chat deletion", () => {
  function deferredResponse() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((promiseResolve) => {
      resolve = promiseResolve;
    });
    return { promise, resolve };
  }

  function seedSessionCache() {
    const cachedMessage: ChatMessage = {
      id: "cached-message",
      sessionId: "session-a",
      role: "assistant",
      content: "cached",
      createdAt: "2026-09-19T00:00:00.000Z",
    };
    chatTranscriptCache.activateContext(transcriptCacheContext);
    chatTranscriptCache.putComplete(transcriptCacheContext, "session-a", [cachedMessage]);
  }

  function renderGrid() {
    return render(
      <MemoryRouter initialEntries={["/chat/session-a"]}>
        <ChatTranscriptCacheContext.Provider value={transcriptCacheContext}>
          <Routes>
            <Route path="/chat/*" element={<FreeGrid />} />
          </Routes>
        </ChatTranscriptCacheContext.Provider>
      </MemoryRouter>,
    );
  }

  async function deleteActiveChat() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("session-a"));
  }

  it("evicts the deleted session from the active transcript cache after a 2xx response", async () => {
    seedSessionCache();
    renderGrid();

    await deleteActiveChat();

    await waitFor(() =>
      expect(chatTranscriptCache.get(transcriptCacheContext, "session-a")).toBeUndefined(),
    );
  });

  it("keeps the cached session when deletion returns a non-2xx response", async () => {
    seedSessionCache();
    const deletion = deferredResponse();
    rs.mocked(deleteSession).mockReturnValue(deletion.promise);
    renderGrid();

    await deleteActiveChat();

    await act(async () => deletion.resolve(new Response(null, { status: 500 })));
    expect(chatTranscriptCache.get(transcriptCacheContext, "session-a")).toBeDefined();
  });
});
