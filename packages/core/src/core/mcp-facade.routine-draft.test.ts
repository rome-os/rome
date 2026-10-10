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

  // `activate: true` creates the routine on the guardian's explicit
  // instruction, but only through the agent's own create_routine and only for
  // a target the agent may call — otherwise the click stays the gate.
  describe("propose_routine activate: true", () => {
    type Call = { name: string; input: unknown };
    const setup = (opts: {
      permissions?: Record<string, "permitted" | "denied" | "unknown">;
      argsError?: string;
      createResult?: unknown;
      withGate?: boolean;
      detached?: boolean;
    }) => {
      const calls: Call[] = [];
      const permissions = opts.permissions ?? {};
      const bundle = buildFacadeBundle({
        getActionCatalog: () => [],
        getSkillCatalog: () => [],
        subagentTools: [],
        executeAction: async (name, input) => {
          calls.push({ name, input });
          return opts.createResult ?? { routineId: "r-42" };
        },
        executeSubagent: async () => ({}),
        supportsInteractiveSurface: true,
        interactiveSurfaceDetached: opts.detached ?? false,
        ...(opts.withGate === false
          ? {}
          : {
              routineActivation: {
                canCallAction: (name: string) => permissions[name] ?? "permitted",
                validateArgs: () => opts.argsError ?? null,
              },
            }),
      });
      const tool = bundle.interactiveTools.find((t) => t.name === "propose_routine")!;
      const run = async (input: Record<string, unknown>) =>
        (await tool.handler(input)) as { content: { text: string }[]; isError?: boolean };
      return { calls, run, bundle };
    };
    const parse = (res: { content: { text: string }[] }) =>
      JSON.parse(res.content[0].text) as Record<string, unknown>;

    it("creates the routine via create_routine and reports it active", async () => {
      const { calls, run } = setup({});
      const res = await run({ ...validSchedule, activate: true });
      expect(res.isError).toBeUndefined();
      const routineKey = (calls[0]?.input as { key?: string } | undefined)?.key;
      // A fresh key in the shape the drain mints for draft cards, so the card
      // finds this routine by key after a reload.
      expect(routineKey).toMatch(/^chat-routine:[0-9a-f-]{36}$/);
      expect(calls).toEqual([
        {
          name: "create_routine",
          input: {
            key: routineKey,
            name: "Weekly update reminder",
            trigger: {
              type: "schedule",
              tzid: "America/Los_Angeles",
              tzMode: "floating",
              localTime: "09:00",
              rrule: "FREQ=WEEKLY;BYDAY=FR",
            },
            actionName: "summon",
            args: validSchedule.args,
          },
        },
      ]);
      const outcome = parse(res);
      expect(outcome.routineCard).toBe("active");
      expect(outcome.routineId).toBe("r-42");
      expect(outcome.routineKey).toBe(routineKey);
      expect(outcome.message).toContain("Do NOT call any create action");
    });

    it("falls back to a draft card when the agent may not call the target", async () => {
      const { calls, run } = setup({ permissions: { summon: "denied" } });
      const outcome = parse(await run({ ...validInput, activate: true }));
      expect(calls).toEqual([]);
      expect(outcome.routineCard).toBe("draft");
      expect(outcome.message).toContain('"summon" is not an action you are permitted to call');
    });

    it("falls back to a draft card when the agent may not call create_routine", async () => {
      const { calls, run } = setup({ permissions: { create_routine: "denied" } });
      const outcome = parse(await run({ ...validInput, activate: true }));
      expect(calls).toEqual([]);
      expect(outcome.routineCard).toBe("draft");
    });

    it("falls back to a draft card when the session wires no permission check", async () => {
      const { calls, run } = setup({ withGate: false });
      const outcome = parse(await run({ ...validInput, activate: true }));
      expect(calls).toEqual([]);
      expect(outcome.routineCard).toBe("draft");
    });

    it("errors without a card for an unregistered target action", async () => {
      const { calls, run } = setup({ permissions: { summon: "unknown" } });
      const res = await run({ ...validInput, activate: true });
      expect(calls).toEqual([]);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not a registered action");
    });

    // create_routine checks only that the target exists, so the args check the
    // card's "Turn it on" gets must run here too.
    it("creates nothing when the args don't fit the target action's schema", async () => {
      const { calls, run } = setup({
        argsError: 'args do not satisfy the input schema for action "summon"',
      });
      const res = await run({ ...validInput, activate: true });
      expect(calls).toEqual([]);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("do not satisfy the input schema");
    });

    it("relays a create_routine rejection as an error without a card", async () => {
      const { run } = setup({
        createResult: { status: "error", error: "FREQ=WEEKLY requires BYDAY" },
      });
      const res = await run({ ...validSchedule, activate: true });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("FREQ=WEEKLY requires BYDAY");
      expect(res.content[0].text).toContain("NOT created");
    });

    it("never creates on a detached session", async () => {
      const { calls, run } = setup({ detached: true });
      const res = await run({ ...validInput, activate: true });
      expect(calls).toEqual([]);
      expect(res.isError).toBe(true);
    });

    it("leaves the draft path unchanged without activate", async () => {
      const { calls, run } = setup({});
      const res = await run(validInput);
      expect(calls).toEqual([]);
      expect(res.content[0].text).toContain("routine draft card has been delivered");
    });

    // Exact forks rely on a byte-identical catalog, so wiring the gate must
    // not change what the model sees.
    it("advertises the same schema whether or not the gate is wired", () => {
      const gated = setup({}).bundle.interactiveTools;
      const ungated = setup({ withGate: false }).bundle.interactiveTools;
      const strip = (tools: typeof gated) =>
        tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      expect(strip(gated)).toEqual(strip(ungated));
    });
  });
});
