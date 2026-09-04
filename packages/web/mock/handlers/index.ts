import type { BootstrapState, DashboardIdentity } from "@rome/api-types";
import type {
  ConversationId,
  ConversationSettings,
  ConversationSettingsListItem,
  PartialConversationSettings,
} from "@rome/api-types/conversation-settings";
import type {
  AppRefDto,
  TraceBlockDto,
  TraceSegment,
  TraceSnapshot,
  TraceSummary,
  TurnFeedback,
  TurnFeedbackRating,
} from "@rome/api-types/trace-segments";
import { http, HttpResponse } from "msw";
import type { ApiConnection, Capability } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";
import type { SettingsMap } from "@/hooks/use-settings";
import type { UpgradeStatus } from "@/hooks/use-upgrade-status";
import type {
  AgentCatalogGroup,
  ChatMessage,
  ChatSearchMessageMatch,
  ChatSession,
  ProjectCatalog,
  ProjectOption,
  StreamBlock,
  TurnInfo,
} from "@/lib/chat-types";
import type {
  RemoteTarget,
  RemoteTargetCandidate,
  SyncGroup,
  SyncSourceInfo,
  SyncStatus,
} from "@/lib/sync-api";
import type { ActionCatalogEntry } from "@/hooks/use-action-catalog";
import { activityHandlers, approvalCardId } from "./activity";
import { appHandlers } from "./apps";
import { appKeysHandlers } from "./app-keys";
import { connections } from "./connections-store";
import { dir, file, fileBrowserHandlers, type MockFsNode } from "./file-browser";
import { memoryFileHandlers } from "./memory-files";
import { channelMirrorHandlers } from "./people";
import { peopleHandlers } from "./people-api";
import { routineHandlers } from "./routines";
import { settingsHandlers } from "./settings";

// Fixtures are typed against the same types the fetch sites parse into
// (@rome/api-types where the contract lives there, the web-local types
// otherwise), so a contract change is likely to break `pnpm typecheck` here
// instead of letting mock mode silently drift from the real API. Two limits
// to that guarantee: an empty collection fixture satisfies any element type,
// so it only pins the container shape; and an endpoint parsed by more than
// one site with more than one local type (e.g. /api/chat/sessions, also
// parsed by shell/RecentChats.tsx's local interface) is only pinned to the
// type named here.

const bootstrap: BootstrapState = { phase: "ready" };

const identity: DashboardIdentity = {
  kind: "guardian",
  userId: "mock-guardian",
  displayName: "Mock Guardian",
  avatarUrl: null,
};

const text = (content: string, turnPhase?: "commentary" | "final"): StreamBlock =>
  turnPhase ? { type: "text", content, turnPhase } : { type: "text", content };

// Tool steps, thinking, subagent runs and the usage footer belong to the
// *trace*, not to the message. A turn persists them on a separate `trace` row
// whose content the messages endpoint blanks to "[]" — the row survives only to
// carry `traceSummary`, which is what renders the trace trigger. The drawer then
// lazy-fetches the blocks from /chat/messages/:id/content. Putting any of them
// in the assistant row instead would render them inline in the conversation,
// which is not a state the product can reach.
const traceSnapshots: Record<string, TraceSnapshot> = {};

/** Trace runs are grouped by the app that served the invocation. Core tools and
 *  core agents both resolve to the system pseudo-app on the real resolver, so
 *  the fixtures need one ref rather than a per-tool map. Mirrors core's
 *  SYSTEM_PSEUDO_APP, id included — the id keys `invocationCounts`. */
const ROME_APP: AppRefDto = { id: "rome", name: "Rome", iconUrl: "/icon.svg" };

const PAIRED_STEP_TYPES = new Set(["tool_use", "tool_result", "subagent_start", "subagent_result"]);

/** Blocks the builder consumes for summary state and never emits. They render
 *  nothing, so a segment carrying one is a blank row the real API never sends. */
const LIFECYCLE_TYPES = new Set(["turn_start", "turn_end", "plan_update"]);

const millisBetween = (from?: string, to?: string): number | undefined => {
  if (!from || !to) return undefined;
  const delta = Date.parse(to) - Date.parse(from);
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
};

/**
 * Split a turn's blocks the way the server's segment builder does: consecutive
 * paired tool/subagent blocks collapse into one `run` segment, and everything
 * else stands alone as a `block` segment. `ordinal` is the drawer's render
 * order and runs across both kinds.
 */
function traceSegmentsOf(blocks: TraceBlockDto[]): TraceSegment[] {
  const segments: TraceSegment[] = [];
  let run: TraceBlockDto[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const steps = run.filter((b) => b.type === "tool_use" || b.type === "subagent_start");
    // Paired by the provider's tool-use id, never by adjacency: a run can
    // interleave two calls, and pairing on position would then attribute one
    // step's duration to the other.
    const durations = steps.map((start) => {
      const id = start.type === "tool_use" ? start.id : start.toolUseId;
      const end = run.find(
        (block): block is Extract<TraceBlockDto, { type: "tool_result" | "subagent_result" }> =>
          (block.type === "tool_result" || block.type === "subagent_result") &&
          block.toolUseId === id,
      );
      return millisBetween(start.startedAt, end?.endedAt);
    });
    segments.push({
      kind: "run",
      id: `run-${segments.length}`,
      app: ROME_APP,
      count: steps.length,
      blocks: run,
      // Undefined when any step lacks a timestamp — the contract is a sum over
      // *paired* steps, not a partial total.
      durationMs: durations.some((d) => d === undefined)
        ? undefined
        : durations.reduce((total: number, d) => total + (d ?? 0), 0),
      ordinal: segments.length,
    });
    run = [];
  };
  for (const block of blocks) {
    if (PAIRED_STEP_TYPES.has(block.type)) {
      run.push(block);
      continue;
    }
    // A lifecycle block still closes an open run — it is a boundary — but it
    // contributes no segment of its own.
    if (LIFECYCLE_TYPES.has(block.type)) {
      flushRun();
      continue;
    }
    flushRun();
    segments.push({
      kind: "block",
      id: `block-${segments.length}`,
      block,
      ordinal: segments.length,
    });
  }
  flushRun();
  return segments;
}

/** Read-time aggregation over the turn's blocks — never stored beside them, so
 *  deriving it here is what keeps the trigger's counts honest. */
function traceSummaryOf(blocks: TraceBlockDto[]): TraceSummary {
  // Both invocation-start kinds count. A delegated turn is a step and observes
  // an app exactly as a tool call does, so counting only `tool_use` would leave
  // a turn showing a subagent chip while its trigger claimed nothing ran.
  const totalSteps = blocks.filter(
    (block) => block.type === "tool_use" || block.type === "subagent_start",
  ).length;
  const subagents = blocks
    .filter((block) => block.type === "subagent_start")
    .map((start) => {
      const result = blocks.find(
        (block) => block.type === "subagent_result" && block.toolUseId === start.toolUseId,
      );
      return {
        toolUseId: start.toolUseId,
        agentName: start.agentName,
        sessionId: start.sessionId,
        turnId: start.turnId,
        status: result?.type === "subagent_result" ? result.status : ("running" as const),
      };
    });
  const turnEnd = blocks.find((block) => block.type === "turn_end");
  // `turn_end.status` is the authoritative outcome; the error block only
  // supplies the message. A failed turn shows as failed in the conversation
  // through `terminalError` alone — the error block never leaves the trace.
  const lastError = blocks.filter((block) => block.type === "error").at(-1);
  const failed = turnEnd?.type === "turn_end" && turnEnd.status === "error";
  return {
    distinctApps: totalSteps > 0 ? [ROME_APP] : [],
    totalSteps,
    invocationCounts: totalSteps > 0 ? { [ROME_APP.id]: totalSteps } : {},
    ...(subagents.length > 0 ? { subagents } : {}),
    ...(turnEnd?.type === "turn_end" ? { totalDurationMs: turnEnd.durationMs } : {}),
    ...(turnEnd?.type === "turn_end" && turnEnd.status === "interrupted"
      ? { stoppedByUser: true }
      : {}),
    ...(failed && lastError?.type === "error" ? { terminalError: lastError.error } : {}),
  };
}

/**
 * One exchange: the guardian's prompt, the trace its run produced, and the
 * assistant reply. All three share a `turnId` — the transcript groups rows by
 * that id rather than by adjacency, so modelling the pairing here is what makes
 * the grouped layout (and its trace subtitle slot) reachable in mock mode.
 *
 * `reply` carries only what the real API persists as MessagePart[] — text,
 * cards, recaps. Anything a run produced goes in `traceBlocks`.
 */
const turn = (
  sessionId: string,
  index: number,
  startedAt: string,
  prompt: string,
  reply: StreamBlock[],
  traceBlocks?: TraceBlockDto[],
): ChatMessage[] => {
  const turnId = `${sessionId}-t${index}`;
  const at = (offsetMs: number) => new Date(Date.parse(startedAt) + offsetMs).toISOString();
  const rows: ChatMessage[] = [
    {
      id: `${turnId}-user`,
      sessionId,
      turnId,
      role: "user",
      content: JSON.stringify([text(prompt)]),
      createdAt: startedAt,
    },
  ];
  if (traceBlocks?.length) {
    const traceId = `${turnId}-trace`;
    const summary = traceSummaryOf(traceBlocks);
    traceSnapshots[traceId] = { segments: traceSegmentsOf(traceBlocks), summary };
    rows.push({
      id: traceId,
      sessionId,
      turnId,
      role: "trace",
      // Blanked exactly as `getMessages` blanks it: the blocks reach the client
      // only through the drawer's lazy fetch.
      content: "[]",
      createdAt: at(1_000),
      traceSummary: summary,
    });
  }
  rows.push({
    id: `${turnId}-assistant`,
    sessionId,
    turnId,
    role: "assistant",
    content: JSON.stringify(reply),
    createdAt: at(9_000),
  });
  return rows;
};

// The transcript behind each session — served by /api/chat/sessions/:id/messages
// and searched by /api/chat/sessions/search. `content` is a JSON array of
// StreamBlocks exactly as the real API stores it, so what renders here goes
// through the production parse path rather than a mock-only shortcut.
//
// ChatSearchDialog ranks title/project matches itself and *appends* sessions
// that matched only on message content, so these transcripts deliberately carry
// words absent from their own titles — otherwise the content-only branch is
// unreachable in mock mode. Worked queries: "roadmap" is content-only for both
// chats that mention it, and "brief" matches one title *and* its transcript,
// which is the session that keeps its title rank and gains a snippet.
const transcripts: Record<string, ChatMessage[]> = {
  "mock-chat-1": [
    ...turn(
      "mock-chat-1",
      1,
      "2026-08-04T09:10:00.000Z",
      "Move my morning brief to 7am and drop the calendar section — on days with no meetings it's just noise.",
      [
        text("Let me check what the brief is set to now.", "commentary"),
        text(
          "Done — I moved the brief to 07:00 and dropped the calendar section from the digest. It leads with the inbox now, then weather.",
          "final",
        ),
      ],
      [
        { type: "session_init", sessionId: "mock-chat-1", agent: "briefer" },
        {
          type: "text",
          content: "Let me check what the brief is set to now.",
          turnPhase: "commentary",
        },
        // A tool step is one `tool_use` + one `tool_result`, paired by the
        // provider's tool-use id — which the call carries on `id` and the
        // result references as `toolUseId`. Putting it on the same field twice
        // leaves the result orphaned and it renders as a bare "result" row.
        // `startedAt`/`endedAt` are what give the collapsed step its duration.
        {
          type: "tool_use",
          tool: "settings_get",
          id: "mock-chat-1-tool-1",
          input: { keys: ["morning_brief.time", "morning_brief.sections"] },
          startedAt: "2026-08-04T09:10:03.000Z",
        },
        {
          type: "tool_result",
          tool: "settings_get",
          toolUseId: "mock-chat-1-tool-1",
          output: {
            "morning_brief.time": "08:30",
            "morning_brief.sections": ["calendar", "inbox", "weather"],
          },
          endedAt: "2026-08-04T09:10:04.200Z",
        },
        { type: "turn_end", turnId: "mock-chat-1-t1", status: "completed", durationMs: 8_400 },
      ],
    ),
    ...turn(
      "mock-chat-1",
      2,
      "2026-08-04T09:12:00.000Z",
      "Perfect. Keep the weather line though, I do actually read that one.",
      [text("Kept. Tomorrow's 07:00 brief is inbox, then weather.", "final")],
    ),
    ...turn(
      "mock-chat-1",
      3,
      "2026-08-04T09:20:00.000Z",
      "Did today's brief actually go out? It never reached my phone.",
      [
        text(
          "It was assembled but not delivered — Telegram rejected it with *bot was blocked by the user*. Unblocking the bot there will let tomorrow's through.",
          "final",
        ),
      ],
      [
        { type: "thinking", content: "Check the delivery log before assuming it failed to send." },
        {
          type: "tool_use",
          tool: "channel_delivery_log",
          id: "mock-chat-1-tool-2",
          input: { channel: "telegram", since: "2026-08-04T00:00:00Z" },
          startedAt: "2026-08-04T09:20:02.000Z",
        },
        // A failed step is signalled by the *output*, not by a separate block
        // type: the renderer reads `isError` (and a handful of provider
        // equivalents) off the result to paint the step's status dot red.
        {
          type: "tool_result",
          tool: "channel_delivery_log",
          toolUseId: "mock-chat-1-tool-2",
          output: { isError: true, error: "telegram: 403 bot was blocked by the user" },
          endedAt: "2026-08-04T09:20:03.100Z",
        },
        {
          type: "text",
          content:
            "It was assembled but not delivered — Telegram rejected it with *bot was blocked by the user*. Unblocking the bot there will let tomorrow's through.",
          turnPhase: "final",
        },
        // The turn's accounting footer, and the one place token usage and cost
        // are visible. It renders only when `accounting` is present, so a bare
        // `result` block would be invisible.
        {
          type: "result",
          content: "",
          accounting: {
            provider: "anthropic",
            model: "claude-sonnet-5",
            usage: {
              inputTokens: 8_412,
              outputTokens: 291,
              cacheReadTokens: 24_960,
              cacheWriteTokens: 1_204,
            },
            context: { usedTokens: 34_867, windowTokens: 200_000, remainingTokens: 165_133 },
            costUsd: 0.0374,
            numTurns: 1,
            durationMs: 6_200,
            stopReason: "end_turn",
          },
        },
        { type: "turn_end", turnId: "mock-chat-1-t3", status: "completed", durationMs: 6_400 },
      ],
    ),
  ],
  "mock-chat-2": [
    ...turn(
      "mock-chat-2",
      1,
      "2026-08-03T16:38:00.000Z",
      "Can the launch copy be warmer? The roadmap paragraph reads like a changelog.",
      [
        text(
          [
            "Here's a warmer pass at that paragraph:",
            "",
            "> We built Rome because keeping a household running takes more attention than any one person has to spare.",
            "",
            "Two other things I'd change:",
            "",
            "1. **Cut the version numbers.** They belong in the changelog, not the announcement.",
            "2. **Lead with the reader, not the feature.** Open on what they stop doing, not on what we shipped.",
            "",
            "Want me to take the closing paragraph the same way?",
          ].join("\n"),
          "final",
        ),
      ],
    ),
    ...turn(
      "mock-chat-2",
      2,
      "2026-08-03T16:52:00.000Z",
      "Yes. And give me the announcement banner as a snippet I can paste in.",
      [
        text(
          [
            "Closing paragraph, same treatment:",
            "",
            "> You don't have to hold it all in your head anymore.",
            "",
            "And the banner:",
            "",
            "```tsx",
            'import { Alert, AlertTitle, AlertDescription } from "@rome-os/ui/alert";',
            "",
            "export function LaunchBanner({ onDismiss }: { onDismiss: () => void }) {",
            "  return (",
            '    <Alert variant="info" className="mb-4">',
            "      <AlertTitle>Rome is out of preview</AlertTitle>",
            "      <AlertDescription>",
            "        Everything you set up during the beta carried over — nothing to migrate.",
            "      </AlertDescription>",
            '      <button type="button" onClick={onDismiss}>',
            "        Dismiss",
            "      </button>",
            "    </Alert>",
            "  );",
            "}",
            "```",
            "",
            "It reads the `info` semantic tokens, so it tracks whichever theme is active.",
          ].join("\n"),
          "final",
        ),
        // The recap is lifted out of the flat block flow into the turn's summary
        // group, so it renders above the row rather than in sequence. Seeded
        // without audio: an audioUrl would need a real asset behind it.
        {
          type: "turn_recap",
          content: "Rewrote the closing paragraph and handed over a themed banner component.",
        },
      ],
    ),
    // A turn parked on an unresolved `ask_question` card. `appId` is the "core"
    // sentinel and `builtin` routes the render to rome-web's own QuestionCard
    // rather than an app bundle in a shadow root.
    //
    // One question per branch the card lays out differently, so reading this
    // transcript in mock mode covers all three. The `multi` option past 32
    // characters is what trips the card into its stacked layout.
    ...turn(
      "mock-chat-2",
      3,
      "2026-08-03T17:05:00.000Z",
      "One more pass, but I want it aimed at the people still on the waitlist.",
      [
        text("Before I rewrite it for that audience, three things:", "commentary"),
        {
          type: "pending_interaction",
          toolUseId: "mock-chat-2-ask-1",
          appId: "core",
          render: {
            kind: "inline",
            componentId: "question-card",
            builtin: true,
            props: {
              questions: [
                {
                  id: "tone",
                  question: "How should the rewrite read?",
                  type: "single",
                  options: ["Warm", "Plain", "Playful"],
                  freeText: true,
                },
                {
                  id: "keep",
                  question: "What should the new opening keep?",
                  type: "multi",
                  options: [
                    "The line about not holding it all in your head",
                    "The pricing note",
                    "The beta thank-you",
                  ],
                  freeText: true,
                },
                {
                  id: "avoid",
                  question: "Anything to avoid?",
                  type: "text",
                  optional: true,
                },
              ],
            },
          },
        },
      ],
    ),
  ],
  "mock-chat-3": [
    ...turn(
      "mock-chat-3",
      1,
      "2026-08-01T08:03:00.000Z",
      "What's still open from last week?",
      [
        text(
          "Three things. The kitchen quote came back and is waiting on your sign-off, the school forms are due Friday, and we're still blocked on the vendor invoice; the rest of the roadmap is unchanged.",
          "final",
        ),
      ],
      [
        // The run header: which agent took the turn, and the prompts it opened
        // with. It renders collapsed, so the prompts are the payload under it.
        {
          type: "session_init",
          agent: "main",
          sessionId: "mock-chat-3",
          systemPrompt: "You are Rome, the guardian's household agent.",
          userPrompt: "What's still open from last week?",
        },
        {
          type: "text",
          content:
            "Three things. The kitchen quote came back and is waiting on your sign-off, the school forms are due Friday, and we're still blocked on the vendor invoice; the rest of the roadmap is unchanged.",
          turnPhase: "final",
        },
        { type: "turn_end", turnId: "mock-chat-3-t1", status: "completed", durationMs: 3_100 },
      ],
    ),
    ...turn(
      "mock-chat-3",
      2,
      "2026-08-01T08:09:00.000Z",
      "Chase the vendor invoice and set up a weekly nudge for anything that stalls.",
      [
        text(
          "The invoice is 12 days overdue and their AP address is ap@vendor.example. I've drafted the chase — and here's the weekly nudge you asked for:",
          "final",
        ),
        // The draft card writes through to POST /api/routines when switched on,
        // so a routine created here appears on the Routines page.
        {
          type: "routine_draft_card",
          toolUseId: "mock-chat-3-draft-1",
          draft: {
            sentence: "Every Monday at 9:00 AM, list anything that has stalled and nudge me.",
            name: "Weekly stall check",
            watchLabel: "Every Monday at 9:00 AM",
            thenSummary: "Summarise stalled items and send them to you",
            trigger: {
              type: "schedule",
              tzid: "America/Los_Angeles",
              localTime: "09:00",
              rrule: "FREQ=WEEKLY;BYDAY=MO",
            },
            actionName: "daily_summary",
            args: { filter: "stalled" },
          },
        },
      ],
      [
        // A delegated turn. The child's run is its own trace; what surfaces on
        // the parent is this pair, which the summary projects into the header's
        // subagent chip. `sessionId` is the *child's* session, not this one.
        {
          type: "subagent_start",
          agentName: "researcher",
          sessionId: "mock-subagent-1",
          turnId: "mock-subagent-1-t1",
          toolUseId: "mock-chat-3-sub-1",
          input: { task: "Find the vendor's billing contact and the invoice's current status" },
          startedAt: "2026-08-01T08:09:04.000Z",
        },
        {
          type: "subagent_result",
          agentName: "researcher",
          sessionId: "mock-subagent-1",
          turnId: "mock-subagent-1-t1",
          toolUseId: "mock-chat-3-sub-1",
          status: "completed",
          output: {
            billingContact: "ap@vendor.example",
            invoiceStatus: "issued, unpaid, 12 days overdue",
          },
          endedAt: "2026-08-01T08:09:31.500Z",
        },
        { type: "turn_end", turnId: "mock-chat-3-t2", status: "completed", durationMs: 34_200 },
      ],
    ),
    ...turn(
      "mock-chat-3",
      3,
      "2026-08-01T08:14:00.000Z",
      "Now pull the invoice PDF off their portal.",
      [text("Fetching it from the vendor portal.", "commentary")],
      [
        {
          type: "text",
          content: "Fetching it from the vendor portal.",
          turnPhase: "commentary",
        },
        // A run that died rather than answered. `code`/`provider`/`reason` are
        // what let the error row explain itself instead of showing a bare
        // string, and the summary's `terminalError` is what marks the turn
        // failed in the conversation without the error leaking into it.
        {
          type: "error",
          error: "The model provider is unavailable — the run stopped here.",
          code: "model_provider_unavailable",
          provider: "anthropic",
          reason: "quota_exhausted",
        },
        { type: "turn_end", turnId: "mock-chat-3-t3", status: "error", durationMs: 2_800 },
      ],
    ),
  ],
  "mock-chat-4": [
    ...turn(
      "mock-chat-4",
      1,
      "2026-08-05T08:40:00.000Z",
      "Tell Ray the plumber is booked for Thursday at 9.",
      [
        text("Ray is outside the household, so this one needs your sign-off.", "commentary"),
        // Bound to the same approval row the Activity page lists, so resolving it
        // from either surface is visible in the other.
        {
          type: "approval_card",
          approvalId: approvalCardId,
          actionName: "send_message",
          status: "pending",
          preview: {
            kind: "sensitive_message",
            channel: "telegram",
            threadId: "dm-42",
            text: "The plumber is booked for Thursday 9am — does that still work for you?",
            reason: "Outbound message to a person outside the household",
          },
        },
      ],
    ),
  ],
};

/** Session metadata is derived from the transcript so `messageCount` and the
 *  activity timestamps can't drift away from the messages they describe. */
const session = (
  id: string,
  name: string,
  projectName = "default",
  agentName?: string,
): ChatSession => {
  const messages = transcripts[id] ?? [];
  const createdAt = messages[0]?.createdAt ?? "2026-08-01T00:00:00.000Z";
  const activityAt = messages[messages.length - 1]?.createdAt ?? createdAt;
  return {
    id,
    name,
    personaId: null,
    projectName,
    agentName: agentName ?? null,
    createdAt,
    activityAt,
    lastSeenActivityAt: activityAt,
    unread: false,
    messageCount: messages.length,
  };
};

const chatSessions: ChatSession[] = [
  // Pinned to the Morning Brief app's agent so the pinned-identity surfaces
  // (navbar avatar/label, composer chip — and their presentation-mode mask)
  // are exercisable in mock mode.
  session("mock-chat-1", "Morning brief tweaks", "default", "morning-brief:briefer"),
  session("mock-chat-2", "Draft launch email", "website-redesign"),
  session("mock-chat-3", "Weekly planning"),
  session("mock-chat-4", "Plumber for the leak"),
];

const messageText = (message: ChatMessage): string =>
  (JSON.parse(message.content) as StreamBlock[])
    .filter((b) => b.type === "text" && typeof b.content === "string")
    .map((b) => b.content)
    .join(" ");

/** Elided window around the hit, mirroring the snippet the real route returns. */
const snippetAround = (body: string, needle: string): string => {
  const at = body.toLowerCase().indexOf(needle);
  const start = Math.max(0, at - 40);
  const end = Math.min(body.length, at + needle.length + 40);
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
};

// Mirrors the real route: one match per session — its most recent matching
// message — newest first.
const searchMatches = (query: string): ChatSearchMessageMatch[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return chatSessions
    .flatMap((s): ChatSearchMessageMatch[] => {
      const messages = transcripts[s.id] ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== "user" && message.role !== "assistant") continue;
        const body = messageText(message);
        if (!body.toLowerCase().includes(needle)) continue;
        return [
          {
            session: s,
            message: {
              id: message.id,
              role: message.role,
              snippet: snippetAround(body, needle),
              createdAt: message.createdAt,
            },
          },
        ];
      }
      return [];
    })
    .sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt));
};

/** `<sessionId>:<turnId>` → the rating the guardian left this session. */
const turnFeedback = new Map<string, TurnFeedback>();

const chatAgents: AgentCatalogGroup[] = [
  {
    ownerId: "core",
    ownerType: "core",
    label: "Rome",
    description: "Built-in agents",
    iconUrl: null,
    agents: [
      { name: "main", description: "The guardian's primary agent" },
      { name: "envoy", description: "Handles messages from everyone who isn't the guardian" },
    ],
  },
  {
    ownerId: "morning-brief",
    ownerType: "app",
    label: "Morning Brief",
    description: "Assembles the daily digest",
    iconUrl: null,
    agents: [
      {
        name: "morning-brief:briefer",
        description: "Drafts and schedules the morning brief",
      },
    ],
  },
];

// Long enough to overflow the project picker's 260px list, so the pinned
// "no project selected" row can be exercised against a scrolling list.
const projectCatalog: ProjectCatalog = {
  rootPath: "~/.rome/default/projects",
  defaultPath: "",
  projects: [
    "website-redesign",
    "quarterly-report",
    "recipe-book",
    "rome-notes",
    "budget-2026",
    "conference-talk",
    "garden-plans",
    "home-inventory",
    "reading-list",
    "tax-documents",
    "travel-japan",
    "wedding-toast",
  ].map((name) => ({ name, path: name })),
};

// The /api/sync/* fixtures below serve SourceConnect, which no migrated surface
// reads — they precede that surface's own migration and exist so the connect
// flow is reachable in mock mode meanwhile.
//
// Mirrors GitSyncSource.descriptor: the id is "git" (the provider is "github").
// NewFolderSyncSection looks the source up by `id === "git"`, so a "github" id
// here would model a source the real routes reject.
const syncSources: SyncSourceInfo[] = [
  { id: "git", label: "GitHub", icon: "github", authProvider: "github", available: true },
];

const syncGroups: SyncGroup[] = [
  { id: "mock-guardian", label: "mock-guardian" },
  { id: "acme-inc", label: "acme-inc" },
];

const syncTargets: RemoteTargetCandidate[] = [
  {
    sourceId: "git",
    locator: { fullName: "mock-guardian/website-redesign" },
    label: "mock-guardian/website-redesign",
    description: "Marketing site refresh",
    group: "mock-guardian",
  },
  {
    sourceId: "git",
    locator: { fullName: "mock-guardian/recipe-book" },
    label: "mock-guardian/recipe-book",
    group: "mock-guardian",
    isEmpty: true,
  },
  {
    sourceId: "git",
    locator: { fullName: "acme-inc/quarterly-report" },
    label: "acme-inc/quarterly-report",
    description: "Q3 numbers",
    group: "acme-inc",
  },
];

const actionCatalog: ActionCatalogEntry[] = [
  {
    name: "send_message",
    description: "Send a message to a person over a connected channel (Telegram, WhatsApp, …)",
    type: "system",
    sideEffects: "write",
    requiresApproval: false,
    ownerType: "system",
    ownerId: "system",
    inputSchema: null,
  },
  {
    name: "web_search",
    description: "Search the web and return result snippets",
    type: "system",
    sideEffects: "read-only",
    requiresApproval: false,
    ownerType: "system",
    ownerId: "system",
    inputSchema: null,
  },
  {
    name: "daily_summary",
    description: "Generate the guardian's daily activity summary",
    type: "custom",
    sideEffects: "read-only",
    requiresApproval: false,
    ownerType: "app",
    ownerId: "morning-brief",
    inputSchema: null,
  },
];

// A zone unlikely to match the browser's, so the dashboard's timestamps
// visibly follow the stored setting rather than the machine's clock.
const settings: SettingsMap = { guardianTimezone: "Asia/Tokyo" };

// Triage activity for the Inbox page. Offsets rather than fixed dates, so the
// entries stay recent whenever the mock is opened.
const sentinelLog = [
  {
    id: "sl_01",
    channel: "telegram",
    channelUserId: "tg:4471",
    displayName: "Priya Natarajan",
    text: "Hi! Is this the number for the plumber quote?",
    action: "replied",
    response: "This line belongs to Rome, Mia's assistant. I've passed your note along.",
    reviewed: false,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: "sl_02",
    channel: "whatsapp",
    channelUserId: "wa:15550001",
    displayName: null,
    text: "URGENT: your account will be suspended, click here",
    action: "escalated",
    response: null,
    reviewed: false,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  },
  {
    id: "sl_03",
    channel: "discord",
    channelUserId: "dc:8812",
    displayName: "sam_k",
    text: "gg, rematch tomorrow?",
    action: "ignored",
    response: null,
    reviewed: true,
    createdAt: new Date(Date.now() - 2 * 86_400_000 - 3_600_000).toISOString(),
  },
];

// Projects file-browser fixture. `./file-browser.ts` serves it — the same
// factory the memory dir goes through, since both are the same routes over a
// different root.
const mockBody = (path: string) =>
  `# ${path.split("/").pop()}\n\nMock file content for the dashboard mock mode.\n`;

const projectsTree: MockFsNode[] = [
  dir("projects/demo-app", [
    dir("projects/demo-app/src", [
      file("projects/demo-app/src/index.ts", mockBody("projects/demo-app/src/index.ts")),
    ]),
    file("projects/demo-app/README.md", mockBody("projects/demo-app/README.md")),
    file("projects/demo-app/notes.txt", mockBody("projects/demo-app/notes.txt")),
  ]),
  dir("projects/research", [
    file("projects/research/papers.md", mockBody("projects/research/papers.md")),
  ]),
  file("projects/todo.md", mockBody("projects/todo.md")),
];

const projectFileHandlers = fileBrowserHandlers({
  apiBasePath: "/api/projects",
  logicalRoot: "projects",
  tree: projectsTree,
});

/**
 * The two remaining reads the Settings page makes. Both are unremarkable
 * "nothing configured" payloads, and both have to exist: the page holds its
 * loading gate until `/api/tailscale/devices` settles, and the Connections tab
 * waits on the Composio status alongside `/api/connections`. Left unhandled
 * they fall through to the dev proxy, which only resolves quickly when a
 * refused connection is waiting on the other end — so the page renders on a
 * developer's machine and hangs where nothing is listening.
 */
const tailscale = { mode: "oauth" as const, configured: false, devices: [] };

const composioStatus: { composio: ComposioCliStatus } = {
  composio: {
    installed: false,
    loggedIn: false,
    loginPending: false,
    webUrl: null,
    orgId: null,
    testUserId: null,
    error: null,
  },
};

const conversationDefaults: ConversationSettings = {
  enabled: true,
  activation: { mode: "mention", botMessages: "ignore", whenOthersMentioned: "ignore" },
  replies: { placement: "thread" },
  routing: { agentName: null },
  session: { reset: { mode: "idle", idleMinutes: 10_080 } },
};

const conversationSettings: { items: ConversationSettingsListItem[] } = {
  items: [
    {
      availability: "online",
      source: "configured",
      snapshot: {
        conversation: {
          ref: { connectionId: "discord-1", conversationId: "engineering" as ConversationId },
          service: "discord",
          kind: "group",
          displayName: "can you see active chats?",
          containerName: "Rome",
        },
        supportedFields: [
          "enabled",
          "activation.mode",
          "activation.botMessages",
          "activation.whenOthersMentioned",
          "replies.placement",
          "routing.agentName",
          "session.reset",
        ],
        effective: { ...conversationDefaults, activation: { ...conversationDefaults.activation } },
        overrides: { activation: { botMessages: "ignore" } },
        updatedAt: "2026-08-04T14:02:00.000Z",
        updatedBy: { kind: "guardian", displayName: "Mock Guardian" },
      },
    },
    {
      availability: "offline",
      source: "known",
      snapshot: {
        conversation: {
          ref: { connectionId: "telegram-1", conversationId: "dm-42" as ConversationId },
          service: "telegram",
          kind: "dm",
          displayName: "Ray",
          containerName: undefined,
        },
        supportedFields: ["enabled", "session.reset"],
        effective: {
          ...conversationDefaults,
          session: { reset: { mode: "daily", atHour: 4 } },
        },
        overrides: {},
      },
    },
  ],
};

/**
 * One level of nesting is all the settings shape has (`activation.mode`,
 * `session.reset`, …), so a targeted merge beats pulling in a deep-merge dep.
 */
function mergeSettings<T extends object>(base: T, patch: PartialConversationSettings): T {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...((merged[key] as object | undefined) ?? {}), ...value }
        : value;
  }
  return merged as T;
}

// Mirrors the zod upgradeStatusSchema in hooks/use-upgrade-status.ts;
// `receivedAt` is stamped client-side on receipt, never sent on the wire.
const upgradeStatus = (): Omit<UpgradeStatus, "receivedAt"> => ({
  phase: "idle",
  targetVersion: null,
  deadline: null,
  serverNow: Date.now(),
});

export const handlers = [
  http.get("/api/health", () => HttpResponse.json({ status: "ok" })),
  http.get("/api/bootstrap", () => HttpResponse.json(bootstrap)),
  http.get("/api/auth/me", () => HttpResponse.json(identity)),
  http.get("/api/chat/sessions", () => HttpResponse.json(chatSessions)),
  http.get("/api/chat/sessions/search", ({ request }) => {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return HttpResponse.json(searchMatches(query));
  }),
  http.get("/api/chat/agents", () => HttpResponse.json(chatAgents)),
  // The trace drawer's two loaders. Both answer `{ trace }` and both return a
  // null trace rather than a 404 for a turn that produced no run, which is the
  // drawer's "nothing recorded" state rather than its error state.
  http.get("/api/chat/messages/:messageId/content", ({ params }) =>
    HttpResponse.json({ trace: traceSnapshots[String(params.messageId)] ?? null }),
  ),
  http.get("/api/sessions/:sessionId/turns/:turnId/trace", ({ params }) =>
    HttpResponse.json({ trace: traceSnapshots[`${params.turnId}-trace`] ?? null }),
  ),
  // Everything below is keyed by :sessionId, so it MUST stay after the literal
  // /sessions/search route above — MSW serves the first handler whose path
  // matches, and ":sessionId" would otherwise swallow "search".
  http.get("/api/chat/sessions/:sessionId", ({ params }) => {
    const found = chatSessions.find((s) => s.id === params.sessionId);
    return found
      ? HttpResponse.json(found)
      : HttpResponse.json({ error: "Unknown session" }, { status: 404 });
  }),
  http.get("/api/chat/sessions/:sessionId/messages", ({ params }) => {
    const messages = transcripts[String(params.sessionId)];
    return messages
      ? HttpResponse.json(messages)
      : HttpResponse.json({ error: "Unknown session" }, { status: 404 });
  }),
  // No turn is ever in flight: the transcripts are static and mock mode has no
  // model behind it, so a session always reads as idle.
  http.get("/api/chat/sessions/:sessionId/turns", () => HttpResponse.json([] as TurnInfo[])),
  http.post("/api/chat/sessions/:sessionId/read", ({ params }) => {
    const found = chatSessions.find((s) => s.id === params.sessionId);
    if (!found) return HttpResponse.json({ error: "Unknown session" }, { status: 404 });
    found.unread = false;
    found.lastSeenActivityAt = found.activityAt;
    return HttpResponse.json({
      sessionId: found.id,
      lastSeenActivityAt: found.lastSeenActivityAt,
      unread: found.unread,
    });
  }),
  // Thumbs on an assistant turn. Each row hydrates lazily as it scrolls into
  // view, so this only became reachable once sessions had a transcript. Kept in
  // memory rather than always-null so a click actually sticks for the session.
  http.get("/api/chat/sessions/:sessionId/turns/:turnId/feedback", ({ params }) => {
    const key = `${params.sessionId}:${params.turnId}`;
    return HttpResponse.json({ feedback: turnFeedback.get(key) ?? null });
  }),
  http.post("/api/chat/sessions/:sessionId/turns/:turnId/feedback", async ({ params, request }) => {
    const key = `${params.sessionId}:${params.turnId}`;
    const existing = turnFeedback.get(key);
    // The real route is write-once per turn; the UI's 409 branch adopts the
    // stored record, and only a stored one exercises it.
    if (existing) return HttpResponse.json({ feedback: existing }, { status: 409 });
    const body = (await request.json()) as { rating: TurnFeedbackRating; comment?: string };
    const feedback: TurnFeedback = {
      rating: body.rating,
      comment: body.comment?.trim() || null,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    turnFeedback.set(key, feedback);
    return HttpResponse.json({ feedback });
  }),
  // The free-canvas widget layout. Empty means "chat only, no widgets"; the PUT
  // is what the canvas writes through on every placement change, and without it
  // each edit logs a failed request.
  http.get("/api/chat/sessions/:sessionId/layout", () => HttpResponse.json({ layout: [] })),
  http.put("/api/chat/sessions/:sessionId/layout", () => new HttpResponse(null, { status: 204 })),
  // Hold the transcript's SSE channel open without emitting. The fixtures never
  // change, so there is nothing to push — but a stream that *closes* reads to
  // Chat.tsx as a dropped connection and drives a reconnect loop.
  http.get("/api/chat/sessions/:sessionId/events", () => {
    const stream = new ReadableStream({ start() {} });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
  }),
  http.get("/api/chat/projects", () => HttpResponse.json(projectCatalog)),
  http.post("/api/chat/projects", async ({ request }) => {
    const body = (await request.json()) as { name: string };
    const created: ProjectOption = { name: body.name, path: body.name };
    return HttpResponse.json(created);
  }),
  // The Memory page's folder panel leads with this read, so an unhandled
  // status leaves the landing view spinning on the dev proxy. Unlinked, which
  // is the state a fresh instance is in and the one that offers Connect.
  http.get("/api/sync/status", () => HttpResponse.json({ state: "unlinked" } satisfies SyncStatus)),
  http.get("/api/sync/sources", () => HttpResponse.json({ sources: syncSources })),
  http.get("/api/sync/groups", () => HttpResponse.json({ groups: syncGroups })),
  // The write half of the connect flow: picking an existing repo POSTs
  // /api/sync/link, and the "Create …" path POSTs /api/sync/targets first.
  // Without both, the flow the dev table documents dies at the last step.
  http.post("/api/sync/targets", async ({ request }) => {
    const body = (await request.json()) as { source: string; name: string; group?: string };
    const label = body.group ? `${body.group}/${body.name}` : body.name;
    const target: RemoteTarget = {
      sourceId: body.source,
      locator: { fullName: label },
      label,
    };
    return HttpResponse.json({ target });
  }),
  http.post("/api/sync/link", async ({ request }) => {
    const body = (await request.json()) as { target: RemoteTarget; source: string };
    const status: SyncStatus = {
      state: "linked",
      ref: "main",
      defaultRef: "main",
      remoteLabel: body.target.label,
      sourceId: body.source,
      private: true,
      changes: { added: 0, modified: 0, removed: 0 },
      ahead: 0,
      behind: 0,
      lastSyncedAt: "2026-08-05T00:00:00.000Z",
    };
    return HttpResponse.json(status);
  }),
  http.get("/api/sync/targets", ({ request }) => {
    const query = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
    const targets = query
      ? syncTargets.filter((t) => t.label.toLowerCase().includes(query))
      : syncTargets;
    return HttpResponse.json({ targets });
  }),
  http.get("/api/actions", () => HttpResponse.json({ actions: actionCatalog })),
  http.get("/api/settings", () => HttpResponse.json(settings)),
  http.get("/api/sentinel-log", () => HttpResponse.json(sentinelLog)),
  http.post("/api/sentinel-log/:id/review", ({ params }) => {
    const entry = sentinelLog.find((candidate) => candidate.id === params.id);
    if (entry) entry.reviewed = true;
    return HttpResponse.json({ ok: true });
  }),
  // Several surfaces write a setting back on mount (last-used project, composer
  // preferences), so a read-only /api/settings makes the dashboard log a failed
  // write on every load.
  http.put("/api/settings", async ({ request }) => {
    Object.assign(settings, (await request.json()) as SettingsMap);
    return HttpResponse.json(settings);
  }),
  http.get("/api/system/upgrade/status/snapshot", () => HttpResponse.json(upgradeStatus())),
  http.get("/api/agents", () => HttpResponse.json({ agents: [{ name: "build" }] })),
  http.get("/api/connections", () => HttpResponse.json(connections)),
  // An authorized grant is what puts Disconnect on a card, so seeding the three
  // above without this would leave every one of those buttons escaping to the
  // dev proxy. Teardown is real here, the way the route runs it: the grant
  // relocks, its identity clears, and the row itself stays so the service is
  // still offered. Reconnecting needs a setup ceremony mock mode does not have
  // (see "What mock mode cannot do"), so a disconnect here is one-way until
  // reload — which is the honest depiction of a fixture with no ceremony
  // behind it, not a gap this handler can paper over.
  http.delete("/api/connections/:id/grants/:name", ({ params }) => {
    const connection = connections.connections.find(
      (candidate) => candidate.id === String(params.id),
    );
    if (!connection) return HttpResponse.json({ error: "Unknown connection." }, { status: 404 });
    const grant = String(params.name);
    if (!(grant in connection.grants)) {
      return HttpResponse.json({ error: "Unknown grant." }, { status: 404 });
    }
    connection.grants[grant] = "unauthorized";
    connection.display[grant] = null;
    // Which capability a grant backs is the registry's to know, and a fixture
    // cannot reproduce that map without inventing it. What it can say without
    // inventing anything: every connection here holds exactly one grant, so
    // losing it locks whatever that connection had unlocked. Capabilities the
    // service never offered stay `unsupported` rather than being reported as
    // merely unauthorized. A multi-grant fixture would need the real map.
    for (const [capability, status] of Object.entries(connection.capabilities)) {
      if (status.state !== "unlocked") continue;
      connection.capabilities[capability as Capability] = {
        state: "needs-auth",
        missingGrants: [grant],
      };
    }
    return HttpResponse.json({ ok: true, connection });
  }),
  http.get("/api/tailscale/devices", () => HttpResponse.json(tailscale)),
  http.get("/api/integrations/composio/status", () => HttpResponse.json(composioStatus)),
  http.get("/api/conversation-settings", () => HttpResponse.json(conversationSettings)),
  // Auto-save writes through on every edit, so mock mode needs a real write
  // path or the dashboard would toast an error on each change.
  http.patch("/api/conversation-settings", async ({ request }) => {
    const body = (await request.json()) as {
      ref: { connectionId: string; conversationId: string };
      set: PartialConversationSettings;
    };
    const found = conversationSettings.items.find(
      (candidate) =>
        candidate.snapshot.conversation.ref.connectionId === body.ref.connectionId &&
        candidate.snapshot.conversation.ref.conversationId === body.ref.conversationId,
    );
    if (!found) return HttpResponse.json({ error: "Unknown conversation" }, { status: 404 });
    found.snapshot.effective = mergeSettings(found.snapshot.effective, body.set);
    found.snapshot.overrides = mergeSettings(found.snapshot.overrides, body.set);
    found.snapshot.updatedAt = new Date().toISOString();
    found.snapshot.updatedBy = { kind: "guardian", displayName: identity.displayName ?? undefined };
    return HttpResponse.json(found.snapshot);
  }),
  // Per-surface fixture modules. Each owns a disjoint slice of the API and
  // orders its own routes internally, so they can be appended in any order —
  // MSW's first-match rule only bites within a path family.
  ...appHandlers,
  ...activityHandlers,
  // The WhatsApp mirror, and the /people contract over the same fixture store.
  // Disjoint path families (/api/whatsapp against /api/people and
  // /api/accounts), so the order between them is free.
  ...channelMirrorHandlers,
  ...peopleHandlers,
  ...routineHandlers,
  ...settingsHandlers,
  ...appKeysHandlers,
  // The two file-browser surfaces, each an in-memory filesystem: the projects
  // dir and the memory dir a person's dossier links into.
  ...projectFileHandlers,
  ...memoryFileHandlers,
];
