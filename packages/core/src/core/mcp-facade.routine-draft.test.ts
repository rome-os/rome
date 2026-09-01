import { describe, it, expect } from "@rstest/core";
import { normalizeRoutineDraftForCard, buildFacadeBundle } from "./mcp-facade.js";

const validInput = {
  kind: "event",
  sentence: "When you get an email from Dana, Rome will summarize it and notify you.",
  name: "Landlord emails",
  watchLabel: "Gmail · new email",
  filterSummary: "sender is dana@example.com",
  thenSummary: "summarize it and notify you",
  eventName: "provider:event:gmail.gmail_new_gmail_message",
  filter: [{ field: "from.email", equals: "dana@example.com" }],
  actionName: "summon",
  args: { agentName: "main", prompt: "Summarize the email." },
};

const validSchedule = {
  kind: "schedule",
  sentence: "Every Friday at 9:00 AM, Rome will remind you to send your weekly update.",
  name: "Weekly update reminder",
  watchLabel: "Every Friday at 9:00 AM",
  thenSummary: "remind you to send your weekly update",
  tzid: "America/Los_Angeles",
  localTime: "09:00",
  rrule: "FREQ=WEEKLY;BYDAY=FR",
  actionName: "summon",
  args: { agentName: "main", prompt: "Remind the guardian to send their weekly update." },
};

describe("normalizeRoutineDraftForCard", () => {
  it("shapes a valid draft into a create-ready event-bus trigger plus display fields", () => {
    const result = normalizeRoutineDraftForCard(validInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.trigger).toEqual({
      type: "event-bus",
      eventName: "provider:event:gmail.gmail_new_gmail_message",
      filter: [{ field: "from.email", equals: "dana@example.com" }],
    });
    expect(result.draft.name).toBe("Landlord emails");
    expect(result.draft.actionName).toBe("summon");
    expect(result.draft.filterSummary).toBe("sender is dana@example.com");
  });

  it("omits the filter when none is given so the routine watches every event of the type", () => {
    const noFilter = { ...validInput, filter: undefined, filterSummary: undefined };
    const result = normalizeRoutineDraftForCard(noFilter);
    expect(result.ok).toBe(true);
    if (!result.ok || result.draft.trigger.type !== "event-bus") throw new Error("expected event");
    expect(result.draft.trigger.filter).toBeUndefined();
    expect(result.draft.filterSummary).toBeUndefined();
  });

  it.each([
    "sentence",
    "name",
    "watchLabel",
    "thenSummary",
    "eventName",
    "actionName",
  ])("fails closed when required field %s is missing", (field) => {
    const broken = { ...validInput, [field]: "" };
    const result = normalizeRoutineDraftForCard(broken);
    expect(result.ok).toBe(false);
  });

  it("rejects array args — the routine engine spreads a single object", () => {
    const result = normalizeRoutineDraftForCard({ ...validInput, args: [{ a: 1 }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a filter condition with a blank field path", () => {
    const result = normalizeRoutineDraftForCard({
      ...validInput,
      filter: [{ field: "  ", equals: "x" }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a draft whose kind is not "event", "schedule", or "manual"', () => {
    const result = normalizeRoutineDraftForCard({ ...validInput, kind: "poll" });
    expect(result.ok).toBe(false);
  });

  it("shapes a manual draft into a manual trigger with no trigger config", () => {
    const result = normalizeRoutineDraftForCard({
      kind: "manual",
      sentence: "A morning briefing you can run by hand whenever you want it.",
      name: "Morning briefing",
      watchLabel: "Run on demand",
      thenSummary: "pull your day and send you a briefing",
      actionName: "summon",
      args: { agentName: "main", prompt: "Build the morning briefing." },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.trigger).toEqual({ type: "manual" });
    // Manual routines carry no payload filter.
    expect(result.draft.filterSummary).toBeUndefined();
  });

  it("shapes a valid schedule draft into a schedule trigger with no filter", () => {
    const result = normalizeRoutineDraftForCard(validSchedule);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.trigger).toEqual({
      type: "schedule",
      tzid: "America/Los_Angeles",
      tzMode: "floating",
      localTime: "09:00",
      rrule: "FREQ=WEEKLY;BYDAY=FR",
    });
    // A schedule never carries a payload filter summary, even if one slips in.
    expect(result.draft.filterSummary).toBeUndefined();
  });

  it("shapes a fixed recurring schedule when tzMode is fixed", () => {
    const result = normalizeRoutineDraftForCard({ ...validSchedule, tzMode: "fixed" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.trigger).toEqual({
      type: "schedule",
      tzid: "America/Los_Angeles",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=WEEKLY;BYDAY=FR",
    });
  });

  it("rejects an invalid tzMode", () => {
    const result = normalizeRoutineDraftForCard({ ...validSchedule, tzMode: "sticky" });
    expect(result.ok).toBe(false);
  });

  it("shapes a one-off schedule (date, no rrule)", () => {
    const result = normalizeRoutineDraftForCard({
      ...validSchedule,
      rrule: undefined,
      date: "2026-07-01",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.trigger).toEqual({
      type: "schedule",
      tzid: "America/Los_Angeles",
      // A dated one-off pins to a fixed absolute zone at creation.
      tzMode: "fixed",
      localTime: "09:00",
      date: "2026-07-01",
    });
  });

  it.each(["tzid", "localTime"])("fails a schedule draft missing %s", (field) => {
    const result = normalizeRoutineDraftForCard({ ...validSchedule, [field]: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects a schedule with a malformed localTime", () => {
    const result = normalizeRoutineDraftForCard({ ...validSchedule, localTime: "9am" });
    expect(result.ok).toBe(false);
  });

  it("rejects a schedule that sets both rrule and date", () => {
    const result = normalizeRoutineDraftForCard({ ...validSchedule, date: "2026-07-01" });
    expect(result.ok).toBe(false);
  });

  it("rejects a MONTHLY rrule without BYMONTHDAY (would silently never fire)", () => {
    const result = normalizeRoutineDraftForCard({ ...validSchedule, rrule: "FREQ=MONTHLY" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown IANA timezone", () => {
    const result = normalizeRoutineDraftForCard({ ...validSchedule, tzid: "Mars/Olympus" });
    expect(result.ok).toBe(false);
  });

  // The routine card is webchat-only; propose_routine registers only on an
  // interactive surface (dashboard + desktop), not on plain messaging channels.
  // ask_question, by contrast, registers everywhere (it relays prose off-webchat).
  it("registers propose_routine only on an interactive surface; ask_question everywhere", () => {
    const params = {
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      executeAction: async () => ({}),
      executeSubagent: async () => ({}),
    };
    const withSurface = buildFacadeBundle({ ...params, supportsInteractiveSurface: true });
    const withoutSurface = buildFacadeBundle({ ...params, supportsInteractiveSurface: false });
    expect(withSurface.interactiveTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["ask_question", "propose_routine"]),
    );
    expect(withoutSurface.interactiveTools.map((t) => t.name)).toEqual(["ask_question"]);
  });

  // confirm_output is the verbal-approval lever for a handback; it must appear
  // only in a conversational handback on an interactive surface, never in a
  // plain chat (which has no Approve gate to resolve).
  it("registers confirm_output only for a handback on an interactive surface", () => {
    const params = {
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      executeAction: async () => ({}),
      executeSubagent: async () => ({}),
      supportsInteractiveSurface: true,
    };
    const handbackSpec = { schema: { type: "object", properties: {} } };
    const handback = buildFacadeBundle({ ...params, handback: handbackSpec });
    const plainChat = buildFacadeBundle(params);
    const noSurface = buildFacadeBundle({
      ...params,
      supportsInteractiveSurface: false,
      handback: handbackSpec,
    });
    expect(handback.interactiveTools.map((t) => t.name)).toContain("confirm_output");
    expect(plainChat.interactiveTools.map((t) => t.name)).not.toContain("confirm_output");
    // ask_question registers on every surface, but confirm_output has no prose
    // fallback — a non-interactive surface never gets it even for a handback.
    expect(noSurface.interactiveTools.map((t) => t.name)).not.toContain("confirm_output");
  });

  // A detached session (exact-mode forked turn) must keep advertising the
  // interactive catalog — its model-visible prefix has to stay byte-identical
  // to the webchat source — but nothing drains its stream to deliver UI, so
  // the handlers must refuse instead of claiming a card was shown or a
  // handback shipped.
  describe("interactiveSurfaceDetached (exact-mode forks)", () => {
    const params = {
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      executeAction: async () => ({}),
      executeSubagent: async () => ({}),
      supportsInteractiveSurface: true,
      handback: { schema: { type: "object", properties: {} } },
      interactiveSurfaceDetached: true,
    };

    it("keeps the advertised interactive catalog identical to the live surface", () => {
      const detached = buildFacadeBundle(params);
      const live = buildFacadeBundle({ ...params, interactiveSurfaceDetached: false });
      expect(detached.interactiveTools.map((t) => t.name)).toEqual(
        live.interactiveTools.map((t) => t.name),
      );
      expect(detached.interactiveTools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["ask_question", "propose_routine", "confirm_output"]),
      );
    });

    it("propose_routine refuses instead of claiming the card was delivered", async () => {
      const bundle = buildFacadeBundle(params);
      const tool = bundle.interactiveTools.find((t) => t.name === "propose_routine")!;
      const res = (await tool.handler(validInput)) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("NOT shown");
      expect(res.content[0].text).not.toContain("has been delivered");
    });

    it("confirm_output refuses instead of claiming the approval was recorded", async () => {
      const bundle = buildFacadeBundle(params);
      const tool = bundle.interactiveTools.find((t) => t.name === "confirm_output")!;
      const res = (await tool.handler({})) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("nothing was shipped");
    });
  });
});
