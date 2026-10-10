import type {
  RomeSessionDetail,
  RomeSessionExplorerRecord,
  RomeSessionOwner,
  RomeSessionsPageResult,
  RunOutcomeSummary,
  RunUsageSummary,
  SessionOwnerFilter,
  SessionQueryRequest,
  SessionSourceFilter,
  SessionsSort,
} from "@rome/api-types/sessions";
import { http, HttpResponse } from "msw";
import type { ChatMessage, ChatSession } from "@/lib/chat-types";

// The session inventory behind `/sessions/all` — POST /api/sessions/query.
//
// The records are data, not derivation: each one carries the owner, trigger and
// counters the real route reads out of the session and run tables, so nothing
// here decides which app owns an agent or what a run cost. What the handler
// does reproduce is the *query* — the scope filter, the search, the sort, the
// facet counts and the page window — mirroring
// packages/core/src/db/repositories/session-query.ts field for field, since a
// list whose filters do nothing tells a reader nothing about the list.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Fixture clock: a literal date would slide out of the 24h and 7d presets. */
const ago = (offsetMs: number): string => new Date(Date.now() - offsetMs).toISOString();

/** Mirrors the preset window in core's query service. */
const PRESET_MS: Record<"24h" | "7d" | "30d", number> = {
  "24h": 24 * HOUR,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

const CORE_OWNER: RomeSessionOwner = { type: "core", id: "core", label: "Rome", iconUrl: null };
const app = (id: string, label: string): RomeSessionOwner => ({
  type: "app",
  id,
  label,
  iconUrl: null,
});
/** An app that ran these sessions and has since been removed. */
const UNINSTALLED_OWNER: RomeSessionOwner = {
  type: "unknown",
  id: null,
  label: "Removed app",
  iconUrl: null,
};

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  costUsd: number | null,
  costedRunCount: number,
): RunUsageSummary => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  costUsd,
  costedRunCount,
});

const outcomes = (
  completed: number,
  error = 0,
  interrupted = 0,
  unknown = 0,
): RunOutcomeSummary => ({
  completed,
  interrupted,
  error,
  unknown,
});

type SessionSeed = Partial<RomeSessionExplorerRecord> &
  Pick<RomeSessionExplorerRecord, "id" | "displayTitle" | "type" | "owner" | "stats"> & {
    activityAt: string;
  };

const record = (seed: SessionSeed): RomeSessionExplorerRecord => ({
  name: seed.displayTitle,
  personaId: null,
  largeModelSelection: null,
  projectName: "default",
  projectPath: "default",
  agentName: null,
  sourceChannel: null,
  sourceThreadId: null,
  sourceThreadName: null,
  sourceThreadType: null,
  triggerKind: null,
  triggerName: null,
  triggerActionName: null,
  triggerExecutionId: null,
  rootActionExecutionId: null,
  parentActionExecutionId: null,
  parentSessionId: null,
  parentTurnId: null,
  createdAt: seed.activityAt,
  messageCount: 0,
  ...seed,
});

/** The app each seeded chat's pinned agent belongs to. Chats with no entry ran
 *  on a core agent. */
const SEEDED_CHAT_OWNERS: Record<string, RomeSessionOwner> = {
  "mock-chat-1": app("morning-brief", "Morning Brief"),
};

/** A seeded chat as the explorer sees it. Run and message counts come off the
 *  transcript, so the inventory row and the conversation cannot disagree. */
const fromSeededChat = (
  chat: ChatSession,
  transcript: ChatMessage[],
): RomeSessionExplorerRecord => {
  const runCount = transcript.filter((message) => message.role === "trace").length;
  return record({
    id: chat.id,
    displayTitle: chat.name,
    type: "webchat",
    agentName: chat.agentName ?? "main",
    owner: SEEDED_CHAT_OWNERS[chat.id] ?? CORE_OWNER,
    projectName: chat.projectName,
    projectPath: chat.projectName,
    sourceChannel: "webchat",
    sourceThreadType: "private",
    createdAt: chat.createdAt,
    activityAt: chat.activityAt,
    messageCount: chat.messageCount,
    stats: {
      runCount,
      usage: usage(
        runCount * 3_100,
        runCount * 640,
        runCount * 11_400,
        runCount * 820,
        runCount * 0.021,
        runCount,
      ),
      outcomes: outcomes(runCount),
    },
  });
};

// Everything the guardian never started from the dashboard: messages that
// arrived on a channel, scheduled and event-driven runs, the forks a rating
// opens, and the subagents a run spawns. Chosen to cover all six session types,
// both source kinds, and each outcome the table renders differently — a failed
// run, an interrupted one, a run with no recorded outcome, and a run whose cost
// the provider never reported.
const backgroundSessions: RomeSessionExplorerRecord[] = [
  record({
    id: "ses-whatsapp-dana",
    displayTitle: "Leak follow-up with Dana",
    type: "channel",
    agentName: "envoy",
    owner: CORE_OWNER,
    sourceChannel: "whatsapp",
    sourceThreadId: "whatsapp-dana",
    sourceThreadName: "Dana Whitfield",
    sourceThreadType: "direct",
    createdAt: ago(3 * HOUR),
    activityAt: ago(28 * 60 * 1000),
    messageCount: 14,
    stats: {
      runCount: 6,
      usage: usage(21_400, 4_120, 68_000, 5_200, 0.19, 6),
      outcomes: outcomes(6),
    },
  }),
  record({
    id: "ses-telegram-ines",
    displayTitle: "Roadmap questions from Ines",
    type: "channel",
    agentName: "envoy",
    owner: CORE_OWNER,
    sourceChannel: "telegram",
    sourceThreadId: "telegram-ines",
    sourceThreadName: "Ines Ferreira",
    sourceThreadType: "direct",
    createdAt: ago(2 * DAY),
    activityAt: ago(5 * HOUR),
    messageCount: 9,
    stats: {
      runCount: 4,
      usage: usage(12_900, 2_640, 41_000, 3_100, 0.11, 4),
      outcomes: outcomes(3, 0, 1),
    },
  }),
  record({
    id: "ses-email-invoice",
    displayTitle: "Invoice from the plumber",
    type: "channel",
    agentName: "envoy",
    owner: CORE_OWNER,
    sourceChannel: "email",
    sourceThreadId: "email-invoice-8821",
    sourceThreadName: "Bay Plumbing Co.",
    sourceThreadType: "direct",
    createdAt: ago(9 * DAY),
    activityAt: ago(9 * DAY),
    messageCount: 4,
    stats: {
      runCount: 2,
      usage: usage(6_300, 980, 18_400, 1_100, 0.04, 2),
      outcomes: outcomes(2),
    },
  }),
  record({
    id: "ses-brief-today",
    displayTitle: "Morning brief",
    type: "action",
    agentName: "morning-brief:briefer",
    owner: app("morning-brief", "Morning Brief"),
    triggerKind: "schedule",
    triggerName: "Morning brief",
    triggerActionName: "morning-brief:daily_summary",
    triggerExecutionId: "exec-brief-4120",
    rootActionExecutionId: "exec-brief-4120",
    createdAt: ago(6 * HOUR),
    activityAt: ago(6 * HOUR),
    messageCount: 3,
    stats: {
      runCount: 1,
      usage: usage(8_800, 1_900, 26_000, 2_400, 0.06, 1),
      outcomes: outcomes(1),
    },
  }),
  record({
    id: "ses-brief-yesterday",
    displayTitle: "Morning brief",
    type: "action",
    agentName: "morning-brief:briefer",
    owner: app("morning-brief", "Morning Brief"),
    triggerKind: "schedule",
    triggerName: "Morning brief",
    triggerActionName: "morning-brief:daily_summary",
    triggerExecutionId: "exec-brief-4098",
    rootActionExecutionId: "exec-brief-4098",
    createdAt: ago(30 * HOUR),
    activityAt: ago(30 * HOUR),
    messageCount: 3,
    stats: {
      runCount: 1,
      usage: usage(8_100, 1_750, 24_600, 2_300, 0.06, 1),
      outcomes: outcomes(1),
    },
  }),
  record({
    id: "ses-inbox-sweep",
    displayTitle: "Weekday inbox sweep",
    type: "action",
    agentName: "main",
    owner: CORE_OWNER,
    triggerKind: "schedule",
    triggerName: "Weekday inbox sweep",
    triggerActionName: "inbox_scan",
    triggerExecutionId: "exec-sweep-2207",
    rootActionExecutionId: "exec-sweep-2207",
    createdAt: ago(4 * DAY),
    activityAt: ago(19 * HOUR),
    messageCount: 21,
    stats: {
      runCount: 9,
      usage: usage(34_600, 6_800, 102_000, 8_900, 0.31, 9),
      outcomes: outcomes(8, 1),
    },
  }),
  record({
    id: "ses-expense-import",
    displayTitle: "Import August receipts",
    type: "action",
    agentName: "expense-tracker:importer",
    owner: app("expense-tracker", "Expense Tracker"),
    projectName: "budget-2026",
    projectPath: "budget-2026",
    triggerKind: "event",
    triggerName: "Receipt received",
    triggerActionName: "expense-tracker:import_receipt",
    triggerExecutionId: "exec-expense-981",
    rootActionExecutionId: "exec-expense-981",
    createdAt: ago(2 * DAY),
    activityAt: ago(11 * HOUR),
    messageCount: 8,
    stats: {
      runCount: 5,
      usage: usage(15_200, 2_300, 44_000, 3_600, 0.12, 3),
      outcomes: outcomes(2, 3),
    },
  }),
  record({
    id: "ses-ledger-sync",
    displayTitle: "Nightly ledger sync",
    type: "action",
    agentName: "ledger-sync:syncer",
    owner: UNINSTALLED_OWNER,
    triggerKind: "schedule",
    triggerName: "Nightly ledger sync",
    triggerActionName: "ledger-sync:sync",
    triggerExecutionId: "exec-ledger-77",
    rootActionExecutionId: "exec-ledger-77",
    createdAt: ago(21 * DAY),
    activityAt: ago(21 * DAY),
    messageCount: 2,
    stats: {
      runCount: 2,
      usage: usage(4_100, 700, 9_800, 600, null, 0),
      outcomes: outcomes(0, 0, 0, 2),
    },
  }),
  record({
    id: "ses-weather-digest",
    displayTitle: "Weekend forecast digest",
    type: "action",
    agentName: "weather:forecaster",
    owner: app("weather", "Weather"),
    triggerKind: "schedule",
    triggerName: "Weekend forecast",
    triggerActionName: "weather:forecast_digest",
    triggerExecutionId: "exec-weather-512",
    rootActionExecutionId: "exec-weather-512",
    createdAt: ago(13 * DAY),
    activityAt: ago(13 * DAY),
    messageCount: 3,
    stats: {
      runCount: 1,
      usage: usage(3_400, 820, 11_200, 900, 0.02, 1),
      outcomes: outcomes(1),
    },
  }),
  record({
    id: "ses-fork-planning",
    displayTitle: "Feedback",
    type: "fork",
    agentName: "main",
    owner: CORE_OWNER,
    sourceChannel: "webchat",
    sourceThreadId: "mock-chat-3",
    sourceThreadName: "Weekly planning",
    sourceThreadType: "private",
    triggerKind: "fork",
    triggerName: "feedback",
    parentSessionId: "mock-chat-3",
    parentTurnId: "mock-chat-3-turn-2",
    createdAt: ago(8 * DAY),
    activityAt: ago(8 * DAY),
    messageCount: 2,
    stats: {
      runCount: 1,
      usage: usage(2_200, 410, 7_400, 500, 0.01, 1),
      outcomes: outcomes(1),
    },
  }),
  record({
    id: "ses-fork-retry",
    displayTitle: "Retry the failed import",
    type: "fork",
    agentName: "expense-tracker:importer",
    owner: app("expense-tracker", "Expense Tracker"),
    projectName: "budget-2026",
    projectPath: "budget-2026",
    triggerKind: "fork",
    triggerName: "retry",
    parentSessionId: "ses-expense-import",
    parentTurnId: "ses-expense-import-turn-4",
    createdAt: ago(10 * HOUR),
    activityAt: ago(9 * HOUR),
    messageCount: 5,
    stats: {
      runCount: 3,
      usage: usage(9_700, 1_640, 28_500, 2_100, 0.08, 3),
      outcomes: outcomes(3),
    },
  }),
  record({
    id: "ses-subagent-pricing",
    displayTitle: "Research supplier pricing",
    type: "subagent",
    agentName: "main:researcher",
    owner: CORE_OWNER,
    projectName: "website-redesign",
    projectPath: "website-redesign",
    parentSessionId: "mock-chat-2",
    parentTurnId: "mock-chat-2-turn-1",
    rootActionExecutionId: "exec-research-330",
    parentActionExecutionId: "exec-research-330",
    createdAt: ago(16 * HOUR),
    activityAt: ago(15 * HOUR),
    messageCount: 6,
    stats: {
      runCount: 4,
      usage: usage(48_200, 7_300, 131_000, 9_800, 0.42, 4),
      outcomes: outcomes(4),
    },
  }),
  record({
    id: "ses-subagent-summary",
    displayTitle: "Summarise the thread",
    type: "subagent",
    agentName: "envoy:summariser",
    owner: CORE_OWNER,
    parentSessionId: "ses-whatsapp-dana",
    parentTurnId: "ses-whatsapp-dana-turn-3",
    createdAt: ago(2 * HOUR),
    activityAt: ago(2 * HOUR),
    messageCount: 2,
    stats: {
      runCount: 1,
      usage: usage(6_900, 1_100, 14_300, 1_000, 0.03, 1),
      outcomes: outcomes(1),
    },
  }),
  record({
    id: "ses-handoff-plumber",
    displayTitle: "Plumber for the leak",
    type: "webchat_handoff",
    agentName: "envoy",
    owner: CORE_OWNER,
    sourceChannel: "webchat",
    sourceThreadId: "mock-chat-4",
    sourceThreadName: "Plumber for the leak",
    sourceThreadType: "private",
    parentSessionId: "mock-chat-4",
    createdAt: ago(26 * DAY),
    activityAt: ago(26 * DAY),
    messageCount: 7,
    stats: {
      runCount: 3,
      usage: usage(11_100, 2_050, 33_700, 2_600, 0.09, 2),
      outcomes: outcomes(2, 0, 1),
    },
  }),
];

const matchesOwner = (owner: RomeSessionOwner, filter: SessionOwnerFilter): boolean => {
  if (filter.kind === "core") return owner.type === "core";
  if (filter.kind === "app") return owner.type === "app" && owner.id === filter.appId;
  return owner.type === "unknown";
};

const matchesSource = (channel: string | null, filter: SessionSourceFilter): boolean =>
  filter.kind === "internal" ? channel === null : channel === filter.channel;

/** The fields core's search predicate spans, in the same order. */
const searchFields = (session: RomeSessionExplorerRecord): (string | null)[] => [
  session.name,
  session.id,
  session.sourceThreadName,
  session.sourceThreadId,
  session.agentName,
  session.triggerName,
  session.triggerActionName,
  session.triggerExecutionId,
  session.projectName,
  session.projectPath,
];

const sortValue = (session: RomeSessionExplorerRecord, field: SessionsSort): number => {
  if (field === "runs") return session.stats.runCount;
  if (field === "tokens") return session.stats.usage.totalTokens;
  if (field === "cost") return session.stats.usage.costUsd ?? -1;
  if (field === "errors") return session.stats.outcomes.error;
  return Date.parse(session.activityAt);
};

const facet = (values: (string | null)[]): { value: string | null; count: number }[] => {
  const counts = new Map<string | null, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value ?? "").localeCompare(b.value ?? ""));
};

/**
 * The `/api/sessions/*` routes over a fixture inventory: the four seeded chats
 * plus the background sessions above. `query` lists them, and the id routes open
 * one — a row that lists but cannot be opened is a list mock mode cannot walk.
 *
 * These are a different namespace from the `/api/chat/sessions/*` routes the
 * chat surface uses, and answering one does not answer the other.
 *
 * `scope.runs` is ignored. Its model and outcome filters only ever arrive from a
 * drill-in on the `/sessions` overview, whose metrics endpoint mock mode does
 * not answer, and a fixture record carries no per-run model to filter on.
 */
export function sessionQueryHandlers(
  chats: ChatSession[],
  transcripts: Record<string, ChatMessage[]>,
) {
  const inventory = [
    ...chats.map((chat) => fromSeededChat(chat, transcripts[chat.id] ?? [])),
    ...backgroundSessions,
  ];

  const byId = new Map(inventory.map((session) => [session.id, session]));
  // The transcript a seeded chat already carries. A background session has none
  // in the fixture, which reads as a session with nothing recorded rather than
  // as a missing one.
  const transcriptFor = (id: string): ChatMessage[] => transcripts[id] ?? [];

  return [
    http.get("/api/sessions/:sessionId", ({ params }) => {
      const session = byId.get(String(params.sessionId));
      if (!session) return new HttpResponse(null, { status: 404 });
      // The fixture records carry no parent pointer, so lineage is empty rather
      // than derived — a guess here would be the handler deciding.
      return HttpResponse.json({
        ...session,
        lineage: { parent: null, children: [] },
      } satisfies RomeSessionDetail);
    }),

    http.get("/api/sessions/:sessionId/messages", ({ params }) => {
      const id = String(params.sessionId);
      if (!byId.has(id)) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(transcriptFor(id));
    }),

    http.post("/api/sessions/query", async ({ request }) => {
      const body = (await request.json()) as SessionQueryRequest;
      const { scope } = body;
      const from =
        scope.time.kind === "preset"
          ? Date.now() - PRESET_MS[scope.time.value]
          : scope.time.kind === "absolute"
            ? Date.parse(scope.time.from)
            : null;
      const to = scope.time.kind === "absolute" ? Date.parse(scope.time.to) : Date.now();
      const search = body.search?.trim().toLowerCase() ?? "";
      const sessionScope = scope.sessions;

      const matched = inventory.filter((session) => {
        const at = Date.parse(session.activityAt);
        if (at > to) return false;
        if (from !== null && at < from) return false;
        if (sessionScope?.ids && !sessionScope.ids.includes(session.id)) return false;
        if (sessionScope?.types && !sessionScope.types.includes(session.type)) return false;
        if (sessionScope?.agentNames && !sessionScope.agentNames.includes(session.agentName ?? ""))
          return false;
        if (
          sessionScope?.owners &&
          !sessionScope.owners.some((filter) => matchesOwner(session.owner, filter))
        )
          return false;
        if (
          sessionScope?.sources &&
          !sessionScope.sources.some((filter) => matchesSource(session.sourceChannel, filter))
        )
          return false;
        const prefix = sessionScope?.projectPathPrefix?.replace(/\/+$/, "");
        if (
          prefix &&
          session.projectPath !== prefix &&
          !session.projectPath?.startsWith(`${prefix}/`)
        )
          return false;
        if (search && !searchFields(session).some((field) => field?.toLowerCase().includes(search)))
          return false;
        return true;
      });

      const field = body.sort?.field ?? "activity";
      const direction = body.sort?.direction === "asc" ? 1 : -1;
      const sorted = [...matched].sort((a, b) => {
        const primary = sortValue(a, field) - sortValue(b, field);
        if (primary !== 0) return primary * direction;
        const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (created !== 0) return -created;
        return b.id.localeCompare(a.id);
      });

      const offset = Math.max(0, body.page?.offset ?? 0);
      const limit = Math.min(Math.max(1, body.page?.limit ?? 50), 200);
      const page = sorted.slice(offset, offset + limit);
      const result: RomeSessionsPageResult = {
        sessions: page,
        total: sorted.length,
        offset,
        limit,
        nextOffset: offset + page.length < sorted.length ? offset + page.length : null,
        // Core counts facets over the same predicates as the rows, so a
        // narrowed list narrows its own dropdowns.
        facets: {
          types: facet(sorted.map((session) => session.type)),
          sourceChannels: facet(sorted.map((session) => session.sourceChannel)),
        },
      };
      return HttpResponse.json(result);
    }),
  ];
}
