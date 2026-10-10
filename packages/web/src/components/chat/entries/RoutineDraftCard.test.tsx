// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { RoutineDraftCard } from "./RoutineDraftCard";
import { createRoutine, deleteRoutine, listRoutineRefs, setRoutineEnabled } from "@/lib/chat-api";
import type { RoutineDraftSpec } from "@/lib/chat-types";

// The card reaches the backend through exactly these calls; stub them so the
// component renders from fixture data alone — no agent, no server.
rs.mock("@/lib/chat-api", () => ({
  createRoutine: rs.fn(),
  listRoutineRefs: rs.fn(),
  setRoutineEnabled: rs.fn(),
  deleteRoutine: rs.fn(),
}));

const mockCreate = rs.mocked(createRoutine);
const mockList = rs.mocked(listRoutineRefs);
const mockSetEnabled = rs.mocked(setRoutineEnabled);
const mockDelete = rs.mocked(deleteRoutine);

// The saved state links into the router, so render inside one.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const eventDraft: RoutineDraftSpec = {
  sentence: "When you get an email from Dana, Rome will summarize it and text you.",
  name: "Landlord emails",
  watchLabel: "Gmail · new email",
  filterSummary: "sender is dana@example.com",
  thenSummary: "summarize it and text you",
  trigger: {
    type: "event-bus",
    eventName: "provider:event:gmail.gmail_new_gmail_message",
    filter: [{ field: "from.email", equals: "dana@example.com" }],
  },
  actionName: "summon",
  args: { agentName: "main", prompt: "Summarize the email." },
};

const scheduleDraft: RoutineDraftSpec = {
  sentence: "Every Friday at 9:00 AM, Rome will remind you to send your weekly update.",
  name: "Weekly update reminder",
  watchLabel: "Every Friday at 9:00 AM",
  thenSummary: "remind you to send your weekly update",
  trigger: {
    type: "schedule",
    tzid: "America/Los_Angeles",
    tzMode: "floating",
    localTime: "09:00",
    rrule: "FREQ=WEEKLY;BYDAY=FR",
  },
  actionName: "summon",
  args: { agentName: "main", prompt: "Remind the guardian to send their weekly update." },
};

beforeEach(() => {
  // Default: this routine doesn't exist yet, and creating it succeeds.
  mockList.mockResolvedValue([]);
  mockCreate.mockResolvedValue({ ok: true, status: 201, routineId: "r-1" });
  mockSetEnabled.mockResolvedValue({ ok: true });
  mockDelete.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
});

describe("RoutineDraftCard", () => {
  it("renders an event draft as an Event routine with watch / filter / then rows", async () => {
    render(<RoutineDraftCard draft={eventDraft} />);

    expect(screen.getByText("Event routine")).toBeTruthy();
    expect(screen.getByText(eventDraft.sentence)).toBeTruthy();
    expect(screen.getByText("Watches")).toBeTruthy();
    expect(screen.getByText("Gmail · new email")).toBeTruthy();
    expect(screen.getByText("Only when")).toBeTruthy();
    expect(screen.getByText("sender is dana@example.com")).toBeTruthy();
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();

    // Let the mount lookup settle so it doesn't flag a state update after assert.
    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("renders a schedule draft as a Scheduled routine with a Runs row and no filter", async () => {
    render(<RoutineDraftCard draft={scheduleDraft} />);

    expect(screen.getByText("Scheduled routine")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("Every Friday at 9:00 AM")).toBeTruthy();
    // Schedule routines carry no payload filter.
    expect(screen.queryByText("Only when")).toBeNull();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("renders the action's preview as ground truth in place of the prose summary", async () => {
    const draft: RoutineDraftSpec = {
      ...eventDraft,
      thenSummary: "summarize it and text you",
      preview: {
        kind: "generic",
        title: "Run agent “main”",
        summary: "Summarize the email and notify the guardian.",
      },
    };
    render(<RoutineDraftCard draft={draft} />);

    // The authoritative render shows; the agent's drift-prone prose does not.
    expect(screen.getByText("Run agent “main”")).toBeTruthy();
    expect(screen.getByText("Summarize the email and notify the guardian.")).toBeTruthy();
    expect(screen.queryByText("summarize it and text you")).toBeNull();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("renders preview fields and message body for a send_message routine", async () => {
    const draft: RoutineDraftSpec = {
      ...scheduleDraft,
      actionName: "send_message",
      args: { channel: "telegram", threadId: "t1", text: "Good morning!" },
      preview: {
        kind: "generic",
        title: "Send a message",
        summary: "Good morning!",
        fields: [{ label: "Channel", value: "Telegram" }],
      },
    };
    render(<RoutineDraftCard draft={draft} />);

    expect(screen.getByText("Send a message")).toBeTruthy();
    expect(screen.getByText("Channel")).toBeTruthy();
    expect(screen.getByText("Telegram")).toBeTruthy();
    expect(screen.getByText("Good morning!")).toBeTruthy();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("falls back to the prose summary when the action provides no preview", async () => {
    render(<RoutineDraftCard draft={eventDraft} />);

    // eventDraft has no `preview`, so the Then row uses thenSummary.
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByText(eventDraft.thenSummary)).toBeTruthy();

    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it("turning it on posts the keyed create payload and links to the run history", async () => {
    const user = userEvent.setup();
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(mockCreate).toHaveBeenCalledWith({
      name: "Landlord emails",
      trigger: eventDraft.trigger,
      actionName: "summon",
      args: eventDraft.args,
      key: "chat-routine:card-1",
    });
    await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
    const link = screen.getByRole("link", { name: /view run history/i });
    expect(link.getAttribute("href")).toBe("/routines/r-1");
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
  });

  it("surfaces the server error and keeps the action when creation fails", async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue({ ok: false, status: 400, error: "Routine name already taken" });
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    await waitFor(() => expect(screen.getByText("Routine name already taken")).toBeTruthy());
    expect(screen.queryByText("On")).toBeNull();
    expect(screen.queryByRole("link", { name: /view run history/i })).toBeNull();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });

  it("on reload, finds its routine by key — not by a same-named routine", async () => {
    mockList.mockResolvedValue([
      { id: "r-other", name: "Landlord emails", key: null, enabled: true },
      { id: "r-mine", name: "Renamed in Routines", key: "chat-routine:card-1", enabled: true },
    ]);
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    const link = await screen.findByRole("link", { name: /view run history/i });
    expect(link.getAttribute("href")).toBe("/routines/r-mine");
    expect(screen.getByText("On")).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("offers to turn it on again when its keyed routine no longer exists", async () => {
    mockList.mockResolvedValue([
      { id: "r-other", name: "Landlord emails", key: null, enabled: true },
    ]);
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.queryByText("On")).toBeNull();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });

  it("matches a card without a key (written before keys) by name among unkeyed routines", async () => {
    mockList.mockResolvedValue([
      { id: "r-keyed", name: "Landlord emails", key: "chat-routine:other-card", enabled: true },
      { id: "r-legacy", name: "Landlord emails", key: null, enabled: true },
    ]);
    render(<RoutineDraftCard draft={eventDraft} />);

    const link = await screen.findByRole("link", { name: /view run history/i });
    expect(link.getAttribute("href")).toBe("/routines/r-legacy");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("shows the real bound action name", async () => {
    render(<RoutineDraftCard draft={eventDraft} />);
    expect(screen.getByText("Action")).toBeTruthy();
    expect(screen.getByText("summon")).toBeTruthy();
    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  // `propose_routine` with `activate: true`: the agent created the routine with
  // the card's key, and the part carries its id.
  describe("an activated routine (routineId set)", () => {
    const key = "chat-routine:card-5";
    const ref = { id: "r-5", name: "Landlord emails", key, enabled: true };
    const renderActivated = (draft: RoutineDraftSpec = eventDraft) =>
      render(<RoutineDraftCard draft={draft} routineKey={key} routineId="r-5" />);

    beforeEach(() => {
      mockList.mockResolvedValue([ref]);
    });

    it("opens saved with Pause, Delete and the run-history link — never Turn it on", async () => {
      renderActivated();

      expect(screen.getByText("On")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
      const link = screen.getByRole("link", { name: /view run history/i });
      expect(link.getAttribute("href")).toBe("/routines/r-5");
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("reflects a routine paused elsewhere", async () => {
      mockList.mockResolvedValue([{ ...ref, enabled: false }]);
      renderActivated();
      expect(await screen.findByText("Paused")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    });

    it("pauses and resumes the routine", async () => {
      const user = userEvent.setup();
      renderActivated();
      await waitFor(() => expect(mockList).toHaveBeenCalled());

      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(mockSetEnabled).toHaveBeenCalledWith("r-5", false);
      expect(await screen.findByText("Paused")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Resume" }));
      expect(mockSetEnabled).toHaveBeenLastCalledWith("r-5", true);
      expect(await screen.findByText("On")).toBeTruthy();
    });

    it("surfaces a failed pause and keeps the routine on", async () => {
      const user = userEvent.setup();
      mockSetEnabled.mockResolvedValue({ ok: false, error: "Routine not found" });
      renderActivated();
      await waitFor(() => expect(mockList).toHaveBeenCalled());

      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(await screen.findByText("Routine not found")).toBeTruthy();
      expect(screen.getByText("On")).toBeTruthy();
    });

    it("deletes only after confirmation, then offers Turn it on as the undo", async () => {
      const user = userEvent.setup();
      renderActivated();
      await waitFor(() => expect(mockList).toHaveBeenCalled());

      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(mockDelete).not.toHaveBeenCalled();
      expect(screen.getByText("Delete this routine?")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(mockDelete).toHaveBeenCalledWith("r-5");
      expect(await screen.findByRole("button", { name: /turn it on/i })).toBeTruthy();
      expect(screen.queryByText("On")).toBeNull();
    });

    it("offers Turn it on when the routine was deleted elsewhere", async () => {
      mockList.mockResolvedValue([]);
      renderActivated();
      expect(await screen.findByRole("button", { name: /turn it on/i })).toBeTruthy();
    });

    it("keeps the saved state when the routine list can't load", async () => {
      mockList.mockResolvedValue(null);
      renderActivated();
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      expect(screen.getByText("On")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    });

    it("offers no Pause for a manual routine", async () => {
      renderActivated({
        ...eventDraft,
        watchLabel: "Run on demand",
        filterSummary: undefined,
        trigger: { type: "manual" },
      });
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    });
  });

  // The mount lookup can resolve after the guardian already acted; its older
  // snapshot must not undo what they did.
  describe("a slow mount lookup", () => {
    const deferredList = () => {
      let resolve!: (refs: Awaited<ReturnType<typeof listRoutineRefs>>) => void;
      mockList.mockReturnValue(new Promise((r) => (resolve = r)));
      return (refs: Awaited<ReturnType<typeof listRoutineRefs>>) => resolve(refs);
    };
    const ref = { id: "r-5", name: "Landlord emails", key: "chat-routine:card-5", enabled: true };

    it("doesn't revert a pause made before it returned", async () => {
      const user = userEvent.setup();
      const resolveList = deferredList();
      render(<RoutineDraftCard draft={eventDraft} routineKey={ref.key} routineId="r-5" />);

      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(await screen.findByText("Paused")).toBeTruthy();
      resolveList([ref]);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByText("Paused")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    });

    it("doesn't revert a create made before it returned", async () => {
      const user = userEvent.setup();
      const resolveList = deferredList();
      render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

      await user.click(screen.getByRole("button", { name: /turn it on/i }));
      expect(await screen.findByText("On")).toBeTruthy();
      resolveList([]);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByText("On")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
    });
  });
});
