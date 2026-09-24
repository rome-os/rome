// @rstest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoutineDraftCard } from "./RoutineDraftCard";
import type { RoutineDraftSpec } from "@/lib/chat-types";
import type { Routine } from "@/lib/routine-language";

let fetchMock: ReturnType<typeof rs.fn>;
// Names the mount-time existence guard (GET /api/routines) reports. Default is
// empty so a fresh proposal offers its one-click action.
let existingRoutineNames: string[];
// Response the create POST resolves with. Overridable per test.
let createResponse: () => Response;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

const createdRoutine: Routine = {
  id: "r-1",
  name: eventDraft.name,
  enabled: true,
  trigger: {
    type: "event-bus",
    eventName: "provider:event:gmail.gmail_new_gmail_message",
  },
  actionName: eventDraft.actionName,
  args: eventDraft.args,
  createdAt: "2026-09-19T07:00:00.000Z",
  lastFiredAt: null,
  nextRunAt: null,
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

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderWithQueryClient(children: ReactNode, queryClient = testQueryClient()) {
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

function renderCard(draft: RoutineDraftSpec, queryClient?: QueryClient) {
  return renderWithQueryClient(
    <RoutineDraftCard draft={draft} sessionId="chat-a" turnId="turn-1" toolUseId="draft-tool-1" />,
    queryClient,
  );
}

function postCallCount(): number {
  return fetchMock.mock.calls.filter(
    ([, init]) => ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST",
  ).length;
}

function lastPostBody(): unknown {
  const posts = fetchMock.mock.calls.filter(
    ([, init]) => ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST",
  );
  const [, init] = posts[posts.length - 1] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  existingRoutineNames = [];
  createResponse = () => jsonResponse(createdRoutine, 201);
  // Branch by method so the mount-time existence guard (GET) and the create
  // action (POST) can be driven independently, matching the real endpoints.
  fetchMock = rs.fn((_input: unknown, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") return Promise.resolve(createResponse());
    return Promise.resolve(
      jsonResponse(
        existingRoutineNames.map((name) => ({ name })),
        200,
      ),
    );
  });
  rs.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
  rs.unstubAllGlobals();
});

describe("RoutineDraftCard", () => {
  it("renders an event draft as an Event routine with watch / filter / then rows", () => {
    renderCard(eventDraft);

    expect(screen.getByText("Event routine")).toBeTruthy();
    expect(screen.getByText(eventDraft.sentence)).toBeTruthy();
    expect(screen.getByText("Watches")).toBeTruthy();
    expect(screen.getByText("Gmail · new email")).toBeTruthy();
    expect(screen.getByText("Only when")).toBeTruthy();
    expect(screen.getByText("sender is dana@example.com")).toBeTruthy();
    expect(screen.getByText("Then")).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });

  it("renders a schedule draft as a Scheduled routine with a Runs row and no filter", () => {
    renderCard(scheduleDraft);

    expect(screen.getByText("Scheduled routine")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("Every Friday at 9:00 AM")).toBeTruthy();
    expect(screen.queryByText("Only when")).toBeNull();
  });

  it("renders the action preview as ground truth in place of the prose summary", () => {
    renderCard({
      ...eventDraft,
      preview: {
        kind: "generic",
        title: "Run agent “main”",
        summary: "Summarize the email and notify the guardian.",
      },
    });

    expect(screen.getByText("Run agent “main”")).toBeTruthy();
    expect(screen.getByText("Summarize the email and notify the guardian.")).toBeTruthy();
    expect(screen.queryByText(eventDraft.thenSummary)).toBeNull();
  });

  it("sends the originating chat context on the create request", async () => {
    const user = userEvent.setup();
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(postCallCount()).toBe(1);
    expect(lastPostBody()).toEqual({
      name: "Landlord emails",
      trigger: eventDraft.trigger,
      actionName: "summon",
      args: eventDraft.args,
      enabled: true,
      webchatContext: {
        sessionId: "chat-a",
        turnId: "turn-1",
        toolUseId: "draft-tool-1",
      },
    });
  });

  it("reaches a definitive success from the POST response even if no record push arrives", async () => {
    // The test never simulates the live routine_created_card push, so a card
    // that only settled on that push would spin forever. It must settle from
    // the response itself — without ever sourcing the detail link locally.
    const user = userEvent.setup();
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turning on routine" })).toBeNull();
    // The persisted record remains the sole source of the /routines/:id link;
    // this settled draft never renders one.
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
    expect(postCallCount()).toBe(1);
  });

  it("does not offer a clickable re-creation for a historical already-completed draft", async () => {
    // Reopening a chat whose draft was turned on before the persisted record
    // shipped: it has no companion routine_created_card to suppress it, so the
    // existence guard must keep the one-click action from creating a duplicate.
    existingRoutineNames = [eventDraft.name];
    renderCard(eventDraft);

    await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /turn it on/i })).toBeNull();
    expect(postCallCount()).toBe(0);
    // No local link is invented for the historical draft.
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
  });

  it("does not render completion navigation while creation is pending", async () => {
    createResponse = () => {
      throw new Error("unreachable");
    };
    fetchMock.mockImplementation((_input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") return new Promise(() => {});
      return Promise.resolve(jsonResponse([], 200));
    });
    const user = userEvent.setup();
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(
      screen.getByRole("button", { name: "Turning on routine" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
  });

  it("does not settle to success or seed the cache for a malformed success", async () => {
    createResponse = () => jsonResponse({ id: "r-1" }, 201);
    const queryClient = testQueryClient();
    queryClient.setQueryData<Routine[]>(["routines", "list"], [createdRoutine]);
    const user = userEvent.setup();
    renderCard(eventDraft, queryClient);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    expect(await screen.findByText("Couldn't turn it on (201).")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
    // Malformed success keeps the one-click action available, not a success state.
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
    expect(queryClient.getQueryData(["routines", "list"])).toBeUndefined();
  });

  it("surfaces a failed creation and keeps the one-click action available", async () => {
    createResponse = () => jsonResponse({ error: "Routine name already taken" }, 400);
    const user = userEvent.setup();
    renderCard(eventDraft);

    await user.click(screen.getByRole("button", { name: /turn it on/i }));

    await waitFor(() => expect(screen.getByText("Routine name already taken")).toBeTruthy());
    expect(screen.queryByRole("link", { name: /run history/i })).toBeNull();
    expect(screen.getByRole("button", { name: /turn it on/i })).toBeTruthy();
  });
});
