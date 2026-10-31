// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as chatApiModule from "@/lib/chat-api" with { rstest: "importActual" };
import { Chat } from "./Chat";
import { ToolTraceContext, type ToolTraceHost } from "@/pages/free/tool-trace";
import { interruptTurn, listSessionMessages, listSessionTurns } from "@/lib/chat-api";

// The Concierge Chat's Stop wiring, with the composer and transcript stood in
// for: the Chat decides whether Stop applies, the composer draws it.

rs.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({ data: { kind: "visitor", accountId: "acct-ana" } }),
}));
rs.mock("@/components/chat/use-session-identity", () => ({
  useSessionIdentity: () => ({ sessionName: null, pinnedAgentMention: null, archivedAt: null }),
}));
rs.mock("@/components/concierge/ConciergeTasksPill", () => ({ ConciergeTasksPill: () => null }));
rs.mock("@/pages/free/workspace-context", () => ({
  snapshotWorkspaceForSend: () => null,
  useWorkspaceContextRegistry: () => null,
}));
rs.mock("@/pages/free/workspace-event-bus", () => ({ useWorkspaceEventBus: () => null }));
rs.mock("@/pages/free/use-free-cells", () => ({
  applyAgentPlacement: rs.fn(),
  useFreeCells: () => ({
    addWidget: rs.fn(),
    placements: [],
    toolView: { activeId: null, collapsed: true, unreadIds: [] },
    setToolsCollapsed: rs.fn(),
  }),
}));
rs.mock("@/hooks/use-stick-to-bottom", () => ({
  useStickToBottom: () => ({
    contentRef: rs.fn(),
    scrollRef: rs.fn(),
    isAtBottom: true,
    scrollToBottom: rs.fn(),
  }),
}));
rs.mock("@/components/agent-trace/TraceDrawer", () => ({ TraceDrawer: () => null }));
rs.mock("@/components/chat/AgentAvatar", () => ({ AgentAvatar: () => null }));
rs.mock("@/components/chat/ShareBar", () => ({ ShareBar: () => null }));
rs.mock("@/pages/free/WidgetPicker", () => ({ WidgetPicker: () => null }));
rs.mock("@/components/chat/MessageList", () => ({
  MessageList: () => null,
  findActiveSubmission: () => null,
  findLastSubmission: () => null,
  hasPendingApprovalConfirmation: () => false,
}));
rs.mock("@/components/chat/entries", () => ({
  renderFlatEntries: () => null,
  renderSingleEntry: () => null,
}));
rs.mock("@/components/chat/composer/ConciergeComposer", () => ({
  ConciergeComposer: forwardRef(function ConciergeComposer(
    props: { isStreaming?: boolean; canStop?: boolean; onStop?: () => Promise<boolean> },
    _ref,
  ) {
    const [confirmed, setConfirmed] = useState<boolean | null>(null);
    return (
      <div data-testid="composer" data-streaming={String(!!props.isStreaming)}>
        {props.canStop && props.onStop ? (
          <button
            type="button"
            data-testid="stop"
            data-confirmed={String(confirmed)}
            onClick={() => void props.onStop?.().then(setConfirmed)}
          />
        ) : null}
      </div>
    );
  }),
}));
rs.mock("@/lib/chat-api", () => {
  const listSessionMessages = rs.fn().mockResolvedValue([]);
  return {
    ...chatApiModule,
    interruptTurn: rs.fn(),
    listSessionMessages,
    listSessionMessagePage: rs.fn(async (id: string) => {
      const all = await listSessionMessages(id);
      return all === null ? null : { messages: all, nextCursor: null };
    }),
    listSessionTurns: rs.fn(),
    markSessionRead: rs.fn().mockResolvedValue({
      sessionId: "concierge",
      lastSeenActivityAt: null,
      unread: false,
    }),
    openTurnStream: rs.fn((_turnId: string, signal?: AbortSignal) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
      ),
    ),
  };
});

const toolTrace: ToolTraceHost = {
  outlet: null,
  paneOpen: false,
  setPaneCollapsed: rs.fn(),
  reveal: rs.fn(),
  set: rs.fn(),
};

function renderChat(children: ReactNode) {
  return render(
    <MemoryRouter>
      <ToolTraceContext.Provider value={toolTrace}>{children}</ToolTraceContext.Provider>
    </MemoryRouter>,
  );
}

function runningTurn(turn: { turnId: string; quiet?: boolean }) {
  rs.mocked(listSessionTurns).mockResolvedValue([
    { ...turn, streamId: "s", startedAt: "2026-10-31T00:00:00.000Z", status: "running" },
  ]);
}

const agentSaid = (turnId: string) => ({
  id: "m-1",
  sessionId: "concierge",
  turnId,
  role: "assistant" as const,
  content: JSON.stringify([{ type: "text", content: "On it." }]),
  createdAt: "2026-10-31T00:00:00.000Z",
});

beforeEach(() => {
  rs.mocked(interruptTurn).mockResolvedValue(new Response(null, { status: 202 }));
});

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
});

describe("Concierge Chat Stop", () => {
  it("offers Stop while a turn the guardian can see is running, and stops that turn", async () => {
    runningTurn({ turnId: "turn-1" });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);

    fireEvent.click(await screen.findByTestId("stop"));

    await waitFor(() => expect(interruptTurn).toHaveBeenCalledWith("turn-1"));
  });

  it("offers no Stop while idle", async () => {
    rs.mocked(listSessionTurns).mockResolvedValue([]);
    renderChat(<Chat sessionId="concierge" variant="concierge" />);

    await waitFor(() => expect(listSessionTurns).toHaveBeenCalled());
    expect(screen.queryByTestId("stop")).toBeNull();
  });

  it("offers no Stop for a quiet turn that has not spoken", async () => {
    runningTurn({ turnId: "backend:1", quiet: true });
    renderChat(<Chat sessionId="concierge" variant="concierge" />);

    await waitFor(() =>
      expect(screen.getByTestId("composer").getAttribute("data-streaming")).toBe("true"),
    );
    expect(screen.queryByTestId("stop")).toBeNull();
  });

  it("offers Stop once a quiet turn has said something", async () => {
    runningTurn({ turnId: "backend:1", quiet: true });
    rs.mocked(listSessionMessages).mockResolvedValue([agentSaid("backend:1")]);
    renderChat(<Chat sessionId="concierge" variant="concierge" />);

    expect(await screen.findByTestId("stop")).toBeTruthy();
  });
});

describe("Concierge Chat Stop confirmation", () => {
  it.each([
    ["202 accepted", new Response(null, { status: 202 }), "true"],
    ["404 already ended", new Response(null, { status: 404 }), "true"],
    ["500 refused", new Response("cannot stop", { status: 500 }), "false"],
  ])("resolves the composer's Stop for %s", async (_label, response, confirmed) => {
    runningTurn({ turnId: "turn-1" });
    rs.mocked(interruptTurn).mockResolvedValue(response);
    renderChat(<Chat sessionId="concierge" variant="concierge" />);

    fireEvent.click(await screen.findByTestId("stop"));

    await waitFor(() =>
      expect(screen.getByTestId("stop").getAttribute("data-confirmed")).toBe(confirmed),
    );
  });
});
