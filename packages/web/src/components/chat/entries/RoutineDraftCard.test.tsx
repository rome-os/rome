// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { RoutineDraftCard } from "./RoutineDraftCard";
import {
  createRoutine,
  deleteRoutine,
  listRoutineRefs,
  runRoutineNow,
  setRoutineEnabled,
} from "@/lib/chat-api";
import i18n from "@/i18n";
import type { RoutineDraftSpec } from "@/lib/chat-types";

// The card reaches the backend through exactly these calls; stub them so the
// component renders from fixture data alone — no agent, no server.
rs.mock("@/lib/chat-api", () => ({
  createRoutine: rs.fn(),
  listRoutineRefs: rs.fn(),
  setRoutineEnabled: rs.fn(),
  deleteRoutine: rs.fn(),
  runRoutineNow: rs.fn(),
}));

const mockCreate = rs.mocked(createRoutine);
const mockList = rs.mocked(listRoutineRefs);
const mockSetEnabled = rs.mocked(setRoutineEnabled);
const mockDelete = rs.mocked(deleteRoutine);
const mockRun = rs.mocked(runRoutineNow);

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

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // Default: this routine doesn't exist yet, and creating it succeeds.
  mockList.mockResolvedValue([]);
  mockCreate.mockResolvedValue({ ok: true, status: 201, routineId: "r-1" });
  mockSetEnabled.mockResolvedValue({ ok: true });
  mockDelete.mockResolvedValue({ ok: true });
  mockRun.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
});

// The saved row's title links to the routine's page.
const routineLink = () => screen.getByRole("link", { name: eventDraft.sentence });

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "More" }));
}

describe("RoutineDraftCard", () => {
  it("renders an event draft as one row with its trigger and filter on one line", async () => {
    render(<RoutineDraftCard draft={eventDraft} />);

    expect(screen.getByText(eventDraft.sentence)).toBeTruthy();
    // The button appears once the lookup confirms nothing exists yet.
    expect(await screen.findByRole("button", { name: /turn it on/i })).toBeTruthy();
    expect(screen.getByText(/Gmail · new email · sender is dana@example\.com/)).toBeTruthy();
    // What will run stays folded until asked for.
    expect(screen.queryByText("Then")).toBeNull();
    expect(screen.getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("renders a schedule draft with its schedule and no filter", async () => {
    render(<RoutineDraftCard draft={scheduleDraft} />);

    await screen.findByRole("button", { name: /turn it on/i });
    expect(screen.getByText("Every Friday at 9:00 AM")).toBeTruthy();
    expect(screen.queryByText(/sender is/)).toBeNull();
  });

  it("Details shows the action's preview as ground truth in place of the prose summary", async () => {
    const user = userEvent.setup();
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

    await user.click(await screen.findByRole("button", { name: "Details" }));

    // The authoritative render shows; the agent's drift-prone prose does not.
    expect(screen.getByText("Run agent “main”")).toBeTruthy();
    expect(screen.getByText("Summarize the email and notify the guardian.")).toBeTruthy();
    expect(screen.queryByText("summarize it and text you")).toBeNull();
    // The real bound action, so no summary can stand in for it.
    expect(screen.getByText("Action")).toBeTruthy();
    expect(screen.getByText("summon")).toBeTruthy();
  });

  it("Details shows preview fields and the message body for a send_message routine", async () => {
    const user = userEvent.setup();
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

    await user.click(await screen.findByRole("button", { name: "Details" }));

    expect(screen.getByText("Send a message")).toBeTruthy();
    expect(screen.getByText("Channel")).toBeTruthy();
    expect(screen.getByText("Telegram")).toBeTruthy();
    expect(screen.getByText("Good morning!")).toBeTruthy();
    expect(screen.getByText("send_message")).toBeTruthy();
  });

  it("Details falls back to the prose summary when the action provides no preview", async () => {
    const user = userEvent.setup();
    render(<RoutineDraftCard draft={eventDraft} />);

    await user.click(await screen.findByRole("button", { name: "Details" }));

    // eventDraft has no `preview`, so the Then row uses thenSummary.
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByText(eventDraft.thenSummary)).toBeTruthy();
  });

  it("turning it on posts the keyed create payload and links the row to the routine", async () => {
    const user = userEvent.setup();
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    await user.click(await screen.findByRole("button", { name: /turn it on/i }));

    expect(mockCreate).toHaveBeenCalledWith({
      name: "Landlord emails",
      trigger: eventDraft.trigger,
      actionName: "summon",
      args: eventDraft.args,
      key: "chat-routine:card-1",
    });
    await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
    expect(routineLink().getAttribute("href")).toBe("/routines/r-1");
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
    // A saved card is one row: no trigger line, no Details.
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("surfaces the server error and keeps the action when creation fails", async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue({ ok: false, status: 400, error: "Routine name already taken" });
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    await user.click(await screen.findByRole("button", { name: /turn it on/i }));

    await waitFor(() => expect(screen.getByText("Routine name already taken")).toBeTruthy());
    expect(screen.queryByText("On")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });

  it("on reload, finds its routine by key — not by a same-named routine", async () => {
    mockList.mockResolvedValue([
      { id: "r-other", name: "Landlord emails", key: null, enabled: true },
      { id: "r-mine", name: "Renamed in Routines", key: "chat-routine:card-1", enabled: true },
    ]);
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(routineLink().getAttribute("href")).toBe("/routines/r-mine");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("offers to turn it on again when its keyed routine no longer exists", async () => {
    mockList.mockResolvedValue([
      { id: "r-other", name: "Landlord emails", key: null, enabled: true },
    ]);
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-1" />);

    expect(await screen.findByRole("button", { name: /turn it on/i })).toBeTruthy();
    expect(screen.queryByText("On")).toBeNull();
  });

  it("matches a card without a key (written before keys) by name among unkeyed routines", async () => {
    mockList.mockResolvedValue([
      { id: "r-keyed", name: "Landlord emails", key: "chat-routine:other-card", enabled: true },
      { id: "r-legacy", name: "Landlord emails", key: null, enabled: true },
    ]);
    render(<RoutineDraftCard draft={eventDraft} />);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(routineLink().getAttribute("href")).toBe("/routines/r-legacy");
    expect(mockCreate).not.toHaveBeenCalled();
    // A name match may be an unrelated routine: link only, no menu.
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  // A key outside the chat namespace (e.g. an app's managed routine) never
  // makes the card the routine's owner.
  it("links but offers no controls for a key outside the chat-routine namespace", async () => {
    mockList.mockResolvedValue([
      { id: "r-app", name: "Daily briefing", key: "briefing-daily", enabled: true },
    ]);
    render(<RoutineDraftCard draft={eventDraft} routineKey="briefing-daily" />);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(routineLink()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("renders its labels in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<RoutineDraftCard draft={eventDraft} />);
    expect(await screen.findByRole("button", { name: "开启" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "详情" })).toBeTruthy();
  });

  // `propose_routine` with `activate: true`: the agent created the routine with
  // the card's key, so the lookup finds it.
  describe("an activated routine", () => {
    const key = "chat-routine:card-5";
    const ref = { id: "r-5", name: "Landlord emails", key, enabled: true };
    const renderActivated = (draft: RoutineDraftSpec = eventDraft) =>
      render(<RoutineDraftCard draft={draft} routineKey={key} />);

    beforeEach(() => {
      mockList.mockResolvedValue([ref]);
    });

    it("opens saved as one linked row with a menu — never Turn it on", async () => {
      const user = userEvent.setup();
      renderActivated();

      expect(await screen.findByText("On")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
      expect(routineLink().getAttribute("href")).toBe("/routines/r-5");
      await openMenu(user);
      expect(screen.getByRole("menuitem", { name: "Pause" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("reflects a routine paused elsewhere", async () => {
      const user = userEvent.setup();
      mockList.mockResolvedValue([{ ...ref, enabled: false }]);
      renderActivated();
      expect(await screen.findByText("Paused")).toBeTruthy();
      await openMenu(user);
      expect(screen.getByRole("menuitem", { name: "Resume" })).toBeTruthy();
    });

    it("pauses and resumes the routine", async () => {
      const user = userEvent.setup();
      renderActivated();

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Pause" }));
      expect(mockSetEnabled).toHaveBeenCalledWith("r-5", false);
      expect(await screen.findByText("Paused")).toBeTruthy();

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Resume" }));
      expect(mockSetEnabled).toHaveBeenLastCalledWith("r-5", true);
      expect(await screen.findByText("On")).toBeTruthy();
    });

    it("surfaces a failed pause and keeps the routine on", async () => {
      const user = userEvent.setup();
      mockSetEnabled.mockResolvedValue({ ok: false, error: "Routine not found" });
      renderActivated();

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Pause" }));
      expect(await screen.findByText("Routine not found")).toBeTruthy();
      expect(screen.getByText("On")).toBeTruthy();
    });

    it("deletes only after confirmation, then offers Turn it on as the undo", async () => {
      const user = userEvent.setup();
      renderActivated();

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
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

    // A keyed create of an existing routine answers 409 with its id, so the
    // fallback can't duplicate it.
    it("offers Turn it on when the routine list can't load", async () => {
      mockList.mockResolvedValue(null);
      renderActivated();
      expect(await screen.findByRole("button", { name: /turn it on/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    });

    it("shows the real state when Turn it on finds the routine already exists", async () => {
      const user = userEvent.setup();
      // The first lookup failed; the routine exists but is paused.
      mockList.mockResolvedValueOnce(null).mockResolvedValue([{ ...ref, enabled: false }]);
      mockCreate.mockResolvedValue({ ok: true, status: 409, routineId: "r-5" });
      renderActivated();

      await user.click(await screen.findByRole("button", { name: /turn it on/i }));
      expect(await screen.findByText("Paused")).toBeTruthy();
    });

    it("offers neither Pause nor Resume when the existing state can't be read", async () => {
      const user = userEvent.setup();
      mockList.mockResolvedValue(null);
      mockCreate.mockResolvedValue({ ok: true, status: 409, routineId: "r-5" });
      renderActivated();

      await user.click(await screen.findByRole("button", { name: /turn it on/i }));
      await openMenu(user);
      expect(screen.queryByText("On")).toBeNull();
      expect(screen.queryByText("Paused")).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Resume" })).toBeNull();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    });

    it("offers Run now instead of Pause for a manual routine", async () => {
      const user = userEvent.setup();
      renderActivated({
        ...eventDraft,
        watchLabel: "Run on demand",
        filterSummary: undefined,
        trigger: { type: "manual" },
      });
      await openMenu(user);
      expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
      // A manual routine never fires on its own: no On / Paused either.
      expect(screen.queryByText("On")).toBeNull();

      await user.click(screen.getByRole("menuitem", { name: "Run now" }));
      expect(mockRun).toHaveBeenCalledWith("r-5");
    });

    it("surfaces a failed run", async () => {
      const user = userEvent.setup();
      mockRun.mockResolvedValue({ ok: false, error: "gh: not authenticated" });
      renderActivated({ ...eventDraft, filterSummary: undefined, trigger: { type: "manual" } });
      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Run now" }));
      expect(await screen.findByText("gh: not authenticated")).toBeTruthy();
    });
  });

  // Until the lookup settles the card can't tell a draft from a routine that
  // already exists, so it offers nothing to click — no stale state to act on.
  it("shows no controls until the lookup settles", async () => {
    let resolve!: (refs: Awaited<ReturnType<typeof listRoutineRefs>>) => void;
    mockList.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<RoutineDraftCard draft={eventDraft} routineKey="chat-routine:card-5" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    resolve([{ id: "r-5", name: "Landlord emails", key: "chat-routine:card-5", enabled: false }]);
    expect(await screen.findByText("Paused")).toBeTruthy();
  });
});
