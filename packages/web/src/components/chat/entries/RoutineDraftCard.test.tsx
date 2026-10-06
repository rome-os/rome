// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutineDraftCard } from "./RoutineDraftCard";
import { createRoutine, listRoutineNames } from "@/lib/chat-api";
import type { RoutineDraftSpec } from "@/lib/chat-types";

// The card reaches the backend through exactly these two calls; stub them so
// the component renders from fixture data alone — no agent, no server.
rs.mock("@/lib/chat-api", () => ({
  createRoutine: rs.fn(),
  listRoutineNames: rs.fn(),
}));

const mockCreate = rs.mocked(createRoutine);
const mockList = rs.mocked(listRoutineNames);

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

  it("turning it on posts the create payload and shows the On state", async () => {
    const user = userEvent.setup();
    render(<RoutineDraftCard draft={eventDraft} />);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(mockCreate).toHaveBeenCalledWith({
      name: "Landlord emails",
      trigger: eventDraft.trigger,
      actionName: "summon",
      args: eventDraft.args,
    });
    await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
    expect(screen.getByText(/Manage it in Routines/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
  });

  it("surfaces the server error and keeps the action when creation fails", async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue({ ok: false, status: 400, error: "Routine name already taken" });
    render(<RoutineDraftCard draft={eventDraft} />);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    await waitFor(() => expect(screen.getByText("Routine name already taken")).toBeTruthy());
    expect(screen.queryByText("On")).toBeNull();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });

  it("shows the On state on mount when the routine already exists", async () => {
    mockList.mockResolvedValue(["Landlord emails"]);
    render(<RoutineDraftCard draft={eventDraft} />);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
