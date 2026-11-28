import { readModelSelectionInput } from "@rome/api-types/models";
import { appConnectionAccessHandlers } from "./app-connection-access";
import type { AccountCodeIssued, BootstrapState, DashboardIdentity } from "@rome/api-types";
import { questionCardRender } from "../fixtures/question-card";
import type { Question } from "@rome/api-types/question-card";
import type { ProviderFailurePart } from "@rome/api-types/chat";
import type {
  ChatId,
  ChatSettingField,
  ChatSettings,
  ChatSettingsListItem,
  PartialChatSettings,
} from "@rome/api-types/chat-settings";
import type {
  AppRefDto,
  TraceEventDto,
  TraceSegment,
  TraceSnapshot,
  TraceSummary,
  TurnFeedback,
  TurnFeedbackRating,
} from "@rome/api-types/trace-segments";
import { http, HttpResponse } from "msw";
import {
  CONCIERGE_CHAT_ID,
  type ConciergeChatsResponse,
  type ConciergeChatWorkResponse,
} from "@rome/api-types/concierge";
import type { Capability } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";
import type { SettingsMap } from "@/hooks/use-settings";
import { CONCIERGE_AGENT_ID } from "@/hooks/use-concierge";
import type { UpgradeStatus } from "@/hooks/use-upgrade-status";
import type {
  AgentCatalogGroup,
  TranscriptPart,
  ChatMessage,
  ChatSearchMessageMatch,
  ChatSession,
  ChatLocations,
  ProjectCatalog,
  ProjectOption,
  SkillSummary,
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
import { vaultHandlers } from "./vault";
import { connectorHandlers } from "./connector";
import { dinnerQuestion, mealPlannerCard, mealPlannerHandlers } from "./meal-planner";
import {
  AGENT_CARD_HEALTH,
  AGENT_CARD_ITINERARY,
  CONNECT_CARD_A2UI,
} from "../fixtures/agent-cards";
import { liveEventsHandlers } from "./live-events";
import { nodeConsoleHandlers } from "./node-console";
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { platformOf } from "@rome/api-types/platform";
import { CHAT_RULE_DEFAULTS, chatRuleDefaultsOf, connections } from "./connections-store";

/** The questions of the mock `ask_question` card: one per layout the card takes. */
const WAITLIST_QUESTIONS: Question[] = [
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
];

import { dir, file, fileBrowserHandlers, type MockFsNode } from "./file-browser";
import { memoryFileHandlers } from "./memory-files";
import { assistantHandlers } from "./assistants";
import { taskListHandlers } from "./task-list";
import { chatOutputHandlers, outputProjectFolder } from "./chat-outputs";
import { routineHandlers } from "./routines";
import { sessionQueryHandlers } from "./sessions";
import { MOCK_OUTAGE_ID, pickerDevices, settingsHandlers } from "./settings";
import { recordedAppHandlers } from "./recorded-apps";
import { shareHandlers } from "./shares";
import { curatedChats } from "../fixtures/chats";
import {
  CONCIERGE_ATTENTION_DIGEST,
  CONCIERGE_FORWARDED_REPORT,
  CONCIERGE_LAS_VEGAS_LIST,
  CONCIERGE_MORNING_DIGEST,
  CONCIERGE_RELEASE_DIGEST,
  CONCIERGE_TRIP_PLAN,
  TASK_CHAT_ANSWER_WITH_CONCLUSION,
  TASK_CHAT_CONCLUSION,
} from "../fixtures/concierge-messages";

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
  displayName: "Rome Demo",
  avatarUrl: null,
};

const skills: SkillSummary[] = [
  {
    name: "@ray/scoped-app:identity_probe",
    localName: "identity_probe",
    description: "Scoped identity probe",
    tools: [],
    ownerType: "app",
    ownerId: "@ray/scoped-app",
    ownerLabel: "Scoped App",
    ownerDescription: "Scoped app test fixture",
    iconUrl: null,
  },
];

const text = (content: string, turnPhase?: "commentary" | "final"): TranscriptPart =>
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
function traceSegmentsOf(blocks: TraceEventDto[]): TraceSegment[] {
  const segments: TraceSegment[] = [];
  let run: TraceEventDto[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const steps = run.filter((b) => b.type === "tool_use" || b.type === "subagent_start");
    // Paired by the provider's tool-use id, never by adjacency: a run can
    // interleave two calls, and pairing on position would then attribute one
    // step's duration to the other.
    const durations = steps.map((start) => {
      const id = start.type === "tool_use" ? start.id : start.toolUseId;
      const end = run.find(
        (block): block is Extract<TraceEventDto, { type: "tool_result" | "subagent_result" }> =>
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
function traceSummaryOf(blocks: TraceEventDto[]): TraceSummary {
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
  const terminal = blocks
    .filter((block) => block.type === "result" || block.type === "error")
    .at(-1);
  const model =
    terminal?.type === "result" || terminal?.type === "error"
      ? terminal.accounting?.model
      : undefined;
  return {
    distinctApps: totalSteps > 0 ? [ROME_APP] : [],
    totalSteps,
    invocationCounts: totalSteps > 0 ? { [ROME_APP.id]: totalSteps } : {},
    ...(subagents.length > 0 ? { subagents } : {}),
    ...(turnEnd?.type === "turn_end" ? { totalDurationMs: turnEnd.durationMs } : {}),
    ...(turnEnd?.type === "turn_end" && turnEnd.status === "interrupted"
      ? { stoppedByUser: true }
      : {}),
    ...(failed && lastError?.type === "error"
      ? {
          terminalError: lastError.error,
          ...(lastError.code ? { terminalErrorCode: lastError.code } : {}),
          ...(lastError.provider ? { terminalErrorProvider: lastError.provider } : {}),
          ...(lastError.reason ? { terminalErrorReason: lastError.reason } : {}),
        }
      : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * One exchange: the guardian's prompt, the trace its run produced, and the
 * assistant reply. All three share a `turnId` — the transcript groups rows by
 * that id rather than by adjacency, so modelling the pairing here is what makes
 * the grouped layout (and its trace subtitle slot) reachable in mock mode.
 *
 * `reply` carries only what the real API persists as MessagePart[] — text,
 * cards, recaps. Anything a run produced goes in `traceEvents`.
 */
const turn = (
  sessionId: string,
  index: number,
  startedAt: string,
  prompt: string | TranscriptPart[],
  reply: TranscriptPart[],
  traceEvents?: TraceEventDto[],
): ChatMessage[] => {
  const turnId = `${sessionId}-t${index}`;
  const at = (offsetMs: number) => new Date(Date.parse(startedAt) + offsetMs).toISOString();
  const rows: ChatMessage[] = [
    {
      id: `${turnId}-user`,
      sessionId,
      turnId,
      role: "user",
      content: JSON.stringify(typeof prompt === "string" ? [text(prompt)] : prompt),
      createdAt: startedAt,
      sender: { kind: "guardian", name: identity.displayName, avatarUrl: identity.avatarUrl },
    },
  ];
  if (traceEvents?.length) {
    const traceId = `${turnId}-trace`;
    const summary = traceSummaryOf(traceEvents);
    traceSnapshots[traceId] = { segments: traceSegmentsOf(traceEvents), summary };
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

// The Concierge's afternoon, as the server sends it: replies that answer
// several topics in turn, interleaved. A reply, the guardian's or the
// Concierge's, carries the quote of the message it replies to, and the chat
// draws it by what sits above it: plain, in a run of replies to one message, or
// with the quote in its bubble. The plumber exchange is a plain back-and-forth.
const NAS_CLEANUP_SCRIPT = `Yes. Give the backup disk a limit, and delete the oldest snapshot when it goes over:

\`\`\`bash
# Every day at 03:00: over 85% full, delete the oldest snapshot
used=$(df --output=pcent /Volumes/Backup | tail -1 | tr -dc '0-9')
if [ "$used" -gt 85 ]; then
  tmutil delete "$(tmutil listbackups | head -1)"
fi
\`\`\`

Want me to set it up as a daily routine?`;
const guardianSender: NonNullable<ChatMessage["sender"]> = {
  kind: "guardian",
  name: identity.displayName,
  avatarUrl: identity.avatarUrl,
};
// Which afternoon message each one replies to, by number.
const AFTERNOON_REPLIES: Record<number, number> = {
  2: 1,
  4: 3,
  5: 1,
  6: 5,
  7: 3,
  9: 6,
  10: 7,
  11: 10,
  12: 8,
  13: 12,
  14: 13,
  15: 9,
  16: 15,
  18: 17,
  19: 18,
  20: 19,
};
const afternoonRoot = (n: number): number => {
  const quoted = AFTERNOON_REPLIES[n];
  return quoted === undefined ? n : afternoonRoot(quoted);
};
const afternoonSaid = new Map<number, { from: "guardian" | "agent"; content: string }>();
const afternoon = (
  n: number,
  at: string,
  from: "guardian" | "agent",
  content: string,
): ChatMessage => {
  afternoonSaid.set(n, { from, content });
  const quoted = AFTERNOON_REPLIES[n];
  const original = quoted === undefined ? undefined : afternoonSaid.get(quoted);
  const quote =
    quoted === undefined || !original
      ? []
      : [
          {
            type: "reply_to",
            messageId: `${CONCIERGE_CHAT_ID}-pm-${quoted}`,
            author: original.from === "guardian" ? "guardian" : "agent",
            text: original.content,
          } as TranscriptPart,
        ];
  return {
    id: `${CONCIERGE_CHAT_ID}-pm-${n}`,
    sessionId: CONCIERGE_CHAT_ID,
    turnId: `${CONCIERGE_CHAT_ID}-pm-turn-${n}`,
    role: from === "guardian" ? "user" : "assistant",
    content: JSON.stringify([...quote, text(content)]),
    createdAt: `2026-08-07T${at}:00.000Z`,
    chatThreadId: `${CONCIERGE_CHAT_ID}-pm-${afternoonRoot(n)}`,
    ...(from === "guardian" ? { sender: guardianSender } : {}),
  };
};

// The transcript behind each session — served by /api/chat/sessions/:id/messages
// and searched by /api/chat/sessions/search. `content` is a JSON array of
// ChatEntries exactly as the real API stores it, so what renders here goes
// through the production parse path rather than a mock-only shortcut.
//
// ChatSearchDialog ranks title/project matches itself and *appends* sessions
// that matched only on message content, so these transcripts deliberately carry
// words absent from their own titles — otherwise the content-only branch is
// unreachable in mock mode. Worked queries: "roadmap" is content-only for both
// chats that mention it, and "brief" matches one title *and* its transcript,
// which is the session that keeps its title rank and gains a snippet.
const transcripts: Record<string, ChatMessage[]> = {
  // The later turns cover the message shapes the Concierge sends: a short
  // answer, and long ones with a table, many links, a digest and a forward.
  [CONCIERGE_CHAT_ID]: [
    // Cards the Concierge composed itself, each a message of its own. They come
    // first, so the later turns the layout checks wait for stay in view.
    ...turn(CONCIERGE_CHAT_ID, 11, "2026-08-04T19:00:00.000Z", "Open an issue in the repo", [
      CONNECT_CARD_A2UI,
    ]),
    ...turn(CONCIERGE_CHAT_ID, 13, "2026-08-04T19:05:00.000Z", "How did I do today?", [
      AGENT_CARD_HEALTH,
    ]),
    ...turn(CONCIERGE_CHAT_ID, 12, "2026-08-04T19:10:00.000Z", "周六在东京怎么安排？", [
      AGENT_CARD_ITINERARY,
    ]),
    ...turn(
      CONCIERGE_CHAT_ID,
      1,
      "2026-08-05T08:42:00.000Z",
      "Draft the launch email and let Ray know about the plumber.",
      [
        { type: "task_chat", chatId: "mock-task-question", title: "Draft launch email" },
        { type: "task_chat", chatId: "mock-chat-4", title: "Plumber for the leak" },
      ],
    ),
    ...turn(CONCIERGE_CHAT_ID, 2, "2026-08-05T09:10:00.000Z", "帮我排一下京都三天的行程", [
      text(CONCIERGE_TRIP_PLAN),
    ]),
    ...turn(CONCIERGE_CHAT_ID, 3, "2026-08-05T09:30:00.000Z", "What shipped this week?", [
      text(CONCIERGE_RELEASE_DIGEST),
    ]),
    ...turn(CONCIERGE_CHAT_ID, 4, "2026-08-06T07:00:00.000Z", "Weather today?", [
      text("Sunny, 24° high, light wind. No umbrella needed."),
      text(CONCIERGE_MORNING_DIGEST),
    ]),
    ...turn(CONCIERGE_CHAT_ID, 5, "2026-08-06T10:00:00.000Z", "How did the plumber visit go?", [
      text("Ray's task chat finished. Here is the report:"),
      {
        type: "text",
        content: CONCIERGE_FORWARDED_REPORT,
        forwardedFrom: { chatId: "mock-chat-4", title: "Plumber for the leak" },
      } as TranscriptPart,
    ]),
    ...turn(CONCIERGE_CHAT_ID, 6, "2026-08-07T07:00:00.000Z", "Anything for me this morning?", [
      text(CONCIERGE_ATTENTION_DIGEST),
    ]),
    ...turn(CONCIERGE_CHAT_ID, 7, "2026-08-07T09:00:00.000Z", "拉斯维加斯有什么值得去的？", [
      text("找景点的任务聊天做完了，结果如下："),
      {
        type: "text",
        content: CONCIERGE_LAS_VEGAS_LIST,
        forwardedFrom: { chatId: "mock-chat-4", title: "拉斯维加斯景点" },
      } as TranscriptPart,
    ]),
    ...turn(CONCIERGE_CHAT_ID, 8, "2026-08-07T12:40:00.000Z", "How much have I eaten today?", [
      mealPlannerCard,
      text("1,240 kcal so far, 760 under your goal. A protein-heavy dinner fits."),
      dinnerQuestion,
    ]),
    // A finished task is reported by forwarding only its conclusion; the chip opens the task chat.
    ...turn(CONCIERGE_CHAT_ID, 9, "2026-08-07T13:00:00.000Z", "How are the Lisbon flights going?", [
      {
        type: "text",
        content: TASK_CHAT_CONCLUSION,
        format: "long",
        forwardedFrom: { chatId: "mock-chat-lisbon", title: "Lisbon flights" },
      } as TranscriptPart,
    ]),
    afternoon(
      1,
      "13:10",
      "guardian",
      "Can you book a table for 4 on Friday evening, somewhere close to the office?",
    ),
    afternoon(2, "13:11", "agent", "I found three tables for Friday at 7."),
    afternoon(
      3,
      "13:12",
      "guardian",
      "Also check flights to Berlin next Tuesday, back on Thursday.",
    ),
    afternoon(4, "13:12", "agent", "On it. I'll compare fares and tell you what I find."),
    afternoon(
      5,
      "13:20",
      "agent",
      "All three take a booking for 4. Osteria 23 has a quiet back room, and it is the closest at 9 minutes on foot. Shall I take that one?",
    ),
    afternoon(6, "13:22", "guardian", "Does the back room have a minimum spend?"),
    afternoon(
      7,
      "13:30",
      "agent",
      "Round trip, Tuesday 11/17 to Thursday 11/19, economy:\n\n1. **Lufthansa LH1135** · 08:40 out, 18:30 back · €210\n2. **Eurowings EW9021** · 07:15 out, 20:50 back · €148, no bag\n3. **Ryanair FR1832** · 06:10 out, 21:40 back · €96, no bag",
    ),
    // A routine made the Concierge speak: its reply carries the routine's name.
    {
      id: `${CONCIERGE_CHAT_ID}-routine-trace`,
      sessionId: CONCIERGE_CHAT_ID,
      turnId: `${CONCIERGE_CHAT_ID}-routine-turn`,
      role: "trace",
      content: "[]",
      createdAt: "2026-08-07T13:32:00.000Z",
      traceSummary: {
        distinctApps: [],
        invocationCounts: {},
        totalSteps: 0,
        automatedInput: { type: "routine", name: "Daily summary" },
      },
    },
    {
      id: `${CONCIERGE_CHAT_ID}-routine-reply`,
      sessionId: CONCIERGE_CHAT_ID,
      turnId: `${CONCIERGE_CHAT_ID}-routine-turn`,
      role: "assistant",
      content: JSON.stringify([text("Today: two meetings, and the plumber at 4.")]),
      createdAt: "2026-08-07T13:32:01.000Z",
    },
    afternoon(8, "13:40", "agent", "Last night's NAS backup failed. I'm looking into why."),
    afternoon(
      9,
      "13:41",
      "agent",
      "Yes, there is a €200 minimum for the back room, which fits a table of 4.",
    ),
    afternoon(10, "13:50", "guardian", "Anything that gets me back on Thursday afternoon?"),
    afternoon(
      11,
      "13:51",
      "agent",
      "Lufthansa has a 14:30 back on Thursday. With the Tuesday morning flight it is €190 round trip.",
    ),
    afternoon(
      12,
      "14:00",
      "agent",
      "The backup disk is full: Time Machine kept 14 months of snapshots and never cleared the old ones. I deleted the ones before 2025, which freed 820 GB, and last night's backup has run again.",
    ),
    afternoon(13, "14:02", "guardian", "Can it clean up by itself from now on?"),
    afternoon(14, "14:03", "agent", NAS_CLEANUP_SCRIPT),
    afternoon(15, "14:15", "guardian", "Book the back room."),
    afternoon(
      16,
      "14:16",
      "agent",
      "Booked: Friday 19:00, Osteria 23 back room, 4 people, under your name. A confirmation text is on its way to your phone.",
    ),
    afternoon(17, "14:20", "guardian", "What time is the plumber coming?"),
    afternoon(18, "14:20", "agent", "At 4 pm. He will call from the car park."),
    afternoon(19, "14:22", "guardian", "Thanks. Does he need a key?"),
    afternoon(20, "14:22", "agent", "No, Ray is home all afternoon."),
    // The owner's latest message, which the Concierge is still working on: it
    // carries the working status, which Rome derives.
    {
      ...turn(CONCIERGE_CHAT_ID, 10, "2026-08-07T14:40:00.000Z", "Book the 9:40 one", [])[0]!,
      status: "working",
    },
  ],
  // The task chat the conclusion above came from: the full answer, then its conclusion.
  "mock-chat-lisbon": [
    ...turn(
      "mock-chat-lisbon",
      1,
      "2026-08-07T09:20:00.000Z",
      "Compare round-trip fares to Lisbon for 1–7 March and tell me what to book.",
      [text(TASK_CHAT_ANSWER_WITH_CONCLUSION)],
    ),
    // A follow-up that could not run: Claude, the default, hit its usage limit.
    ...turn("mock-chat-lisbon", 2, "2026-08-07T14:25:00.000Z", "Book option A.", [
      {
        type: "provider_failure",
        provider: "anthropic",
        reason: "quota",
        card: "wait",
        until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        followsDefault: true,
        alternatives: [],
        chatId: "mock-chat-lisbon",
      },
    ]),
  ],
  "mock-task-question": turn(
    "mock-task-question",
    1,
    "2026-08-05T08:41:00.000Z",
    "Draft the launch email.",
    [
      {
        type: "pending_interaction",
        toolUseId: "mock-task-tone",
        appId: "core",
        render: questionCardRender([
          {
            id: "tone",
            question: "Which tone should the launch email use?",
            type: "single",
            options: ["Warm", "Plain"],
            freeText: true,
          },
        ]),
      },
    ],
  ),
  // The main chat's other task chats, so each opens from its task list row.
  "mock-task-chat-table": turn(
    "mock-task-chat-table",
    1,
    "2026-08-05T08:50:00.000Z",
    "Book a table for four on Friday evening.",
    [text("Osteria 23 has a back room for four at 19:00. It needs your approval to hold it.")],
  ),
  "mock-task-chat-pr-review": turn(
    "mock-task-chat-pr-review",
    1,
    "2026-08-05T09:05:00.000Z",
    "Review the open pull requests.",
    [text("Three are open. I am reading the second one now.")],
  ),
  "mock-task-chat-visa": turn(
    "mock-task-chat-visa",
    1,
    "2026-08-05T09:10:00.000Z",
    "Check the visa appointment.",
    [text("No earlier slot yet. I will look again in 20 minutes.")],
  ),
  ...Object.fromEntries(
    curatedChats.map((chat) => [
      chat.id,
      chat.turns.flatMap((item, index) =>
        turn(chat.id, index + 1, item.at, item.prompt, [text(item.reply), ...(item.blocks ?? [])])
          .filter(
            (row) =>
              row.role !== "assistant" || item.reply.length > 0 || (item.blocks?.length ?? 0) > 0,
          )
          .map((row) =>
            row.role === "user" && item.sender ? { ...row, sender: item.sender } : row,
          ),
      ),
    ]),
  ),
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
          turnId: "mock-chat-2-t2",
          content: "Rewrote the closing paragraph and handed over a themed banner component.",
        },
      ],
    ),
    // A turn parked on an unresolved `ask_question` card, as core stores it:
    // the questions and the card described from them. `appId` is the "core"
    // sentinel and `builtin` routes the render to the question card rather
    // than an app bundle in a shadow root.
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
          render: questionCardRender(WAITLIST_QUESTIONS),
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
          routineKey: "chat-routine:mock-chat-3-draft-1",
          draft: {
            sentence: "Every Monday at 9:00 AM, list anything that has stalled and nudge me.",
            name: "Weekly stall check",
            watchLabel: "Every Monday at 9:00 AM",
            thenSummary: "Summarise stalled items and send them to you",
            trigger: {
              type: "schedule",
              tzid: "America/Los_Angeles",
              tzMode: "floating",
              localTime: "09:00",
              rrule: "FREQ=WEEKLY;BYDAY=MO",
            },
            actionName: "daily_summary",
            args: { filter: "stalled" },
          },
        },
        // An activated card: the agent created the routine on an explicit
        // request (`propose_routine` with `activate: true`), so it opens saved
        // with Pause / Delete / run history instead of "Turn it on".
        {
          type: "routine_draft_card",
          toolUseId: "mock-chat-3-active-1",
          routineKey: "chat-routine:mock-chat-3-active-1",
          draft: {
            sentence: "Every day at 7:00 AM, Rome will send you a morning brief.",
            name: "Morning brief",
            watchLabel: "Every day at 7:00 AM",
            thenSummary: "send you your inbox and weather brief",
            trigger: {
              type: "schedule",
              tzid: "America/Los_Angeles",
              tzMode: "floating",
              localTime: "07:00",
              rrule: "FREQ=DAILY",
            },
            actionName: "daily_summary",
            args: { sections: ["inbox", "weather"] },
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

// The Concierge's topic chats, each with a short exchange, so opening one loads
// like a real chat rather than answering its messages with a 404.
transcripts["mock-topic-travel"] = turn(
  "mock-topic-travel",
  1,
  "2026-08-04T09:00:00.000Z",
  "Where should we stay in Lisbon?",
  [text("Alfama is walkable and quiet at night. I can compare three places if you like.")],
);
transcripts["mock-topic-news"] = turn(
  "mock-topic-news",
  1,
  "2026-08-03T07:30:00.000Z",
  "Send me a weekly news digest.",
  [text("Done. Every Monday at 7:30 I will send the week's top stories.")],
);

// Each state of the provider failure card, and the main chat's grouped
// notice, in a topic chat of their own: the main chat's transcript is the one
// the layout checks measure, so these stay out of it.
const PROVIDER_CARDS_CHAT_ID = "mock-topic-provider-cards";
const providerCard = (part: Omit<ProviderFailurePart, "type" | "chatId">): TranscriptPart => ({
  type: "provider_failure",
  chatId: PROVIDER_CARDS_CHAT_ID,
  ...part,
});
transcripts[PROVIDER_CARDS_CHAT_ID] = [
  ...turn(PROVIDER_CARDS_CHAT_ID, 1, "2026-08-08T09:00:00.000Z", "Plan the Kyoto budget.", [
    providerCard({
      provider: "openai",
      reason: "quota",
      card: "wait",
      until: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      continues: true,
      followsDefault: true,
      alternatives: ["anthropic"],
    }),
  ]),
  // A weekly limit the usage-limit continuation will not take: no promise.
  ...turn(PROVIDER_CARDS_CHAT_ID, 8, "2026-08-08T09:01:00.000Z", "Plan the Osaka leg.", [
    providerCard({
      provider: "openai",
      reason: "quota",
      card: "wait",
      until: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      followsDefault: true,
      alternatives: [],
    }),
  ]),
  // A temporary failure its silent retry did not get past: [Retry].
  ...turn(PROVIDER_CARDS_CHAT_ID, 9, "2026-08-08T09:03:00.000Z", "Check the hotel reviews.", [
    providerCard({
      provider: "anthropic",
      reason: "temporary",
      card: "wait",
      followsDefault: true,
      alternatives: [],
    }),
  ]),
  // Rome credits used up, no account logged in: [Log in].
  ...turn(PROVIDER_CARDS_CHAT_ID, 10, "2026-08-08T09:04:00.000Z", "Book the ryokan.", [
    providerCard({
      provider: "rome_credits",
      reason: "credits_used_up",
      card: "account",
      followsDefault: true,
      alternatives: [],
    }),
  ]),
  // Its reset passed before the sweep ran: the card offers [Continue].
  ...turn(PROVIDER_CARDS_CHAT_ID, 7, "2026-08-08T09:02:00.000Z", "Summarise the board meeting.", [
    providerCard({
      provider: "anthropic",
      reason: "quota",
      card: "wait",
      until: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      followsDefault: true,
      alternatives: [],
    }),
  ]),
  ...turn(PROVIDER_CARDS_CHAT_ID, 2, "2026-08-08T09:05:00.000Z", "Book the 9:40 train.", [
    providerCard({
      provider: "openai",
      reason: "login",
      card: "account",
      followsDefault: true,
      alternatives: ["anthropic"],
      detail: "401 Unauthorized: the refresh token was revoked.",
    }),
  ]),
  ...turn(PROVIDER_CARDS_CHAT_ID, 3, "2026-08-08T09:10:00.000Z", "Summarise the inbox.", [
    providerCard({
      provider: "anthropic",
      reason: "removed",
      card: "account",
      followsDefault: true,
      alternatives: [],
      credits: true,
    }),
  ]),
  ...turn(PROVIDER_CARDS_CHAT_ID, 4, "2026-08-08T09:15:00.000Z", "Draft the release notes.", [
    providerCard({
      provider: "openai",
      reason: "model_unavailable",
      card: "model",
      model: "gpt-6-astra",
      replacement: { selection: "gpt-6-1-sol", model: "gpt-6.1-sol" },
      followsDefault: false,
      alternatives: ["anthropic"],
    }),
  ]),
  ...turn(PROVIDER_CARDS_CHAT_ID, 5, "2026-08-08T09:20:00.000Z", "Check the flight prices.", [
    providerCard({
      provider: "anthropic",
      reason: "quota",
      card: "wait",
      followsDefault: true,
      alternatives: ["openai"],
      resolved: {
        at: "2026-08-08T09:22:00.000Z",
        by: "switched",
        provider: "openai",
        continued: true,
      },
    }),
  ]),
  ...turn(PROVIDER_CARDS_CHAT_ID, 6, "2026-08-08T09:30:00.000Z", "Any updates on the tasks?", [
    {
      type: "provider_outage",
      outageId: MOCK_OUTAGE_ID,
      provider: "anthropic",
      reason: "quota",
      card: "wait",
      until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      chatIds: ["mock-chat-lisbon", "mock-task-question"],
    },
  ]),
];

/** A failure card's button: the card settles in place, as the server rewrites it. */
const settleProviderCard = (messageId: string, change: Record<string, unknown> | null) => {
  for (const messages of Object.values(transcripts)) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) continue;
    const message = messages[index]!;
    const parts = JSON.parse(message.content) as TranscriptPart[];
    const card = parts.find(
      (part): part is ProviderFailurePart => part.type === "provider_failure",
    );
    if (!card || card.resolved) return false;
    card.resolved = !change
      ? { at: new Date().toISOString(), by: "recovered", continued: true }
      : {
          at: new Date().toISOString(),
          by: "switched",
          ...(change.kind === "model"
            ? { model: card.replacement?.model }
            : { provider: change.provider as ProviderFailurePart["provider"] }),
          continued: true,
        };
    messages[index] = { ...message, content: JSON.stringify(parts) };
    return true;
  }
  return false;
};

// A content card beside a question card: the content card reads as wide as a
// text bubble, the question card keeps its narrow width.
const CARD_WIDTHS_CHAT_ID = "mock-topic-card-widths";
transcripts[CARD_WIDTHS_CHAT_ID] = [
  ...turn(CARD_WIDTHS_CHAT_ID, 1, "2026-08-08T10:00:00.000Z", "How did I do this week?", [
    { ...AGENT_CARD_HEALTH, toolUseId: "mock-card-widths-health" } as TranscriptPart,
  ]),
  ...turn(CARD_WIDTHS_CHAT_ID, 2, "2026-08-08T10:05:00.000Z", "Plan a walk for tonight.", [
    {
      type: "pending_interaction",
      toolUseId: "mock-card-widths-question",
      appId: "core",
      render: questionCardRender([
        {
          id: "time",
          question: "When should the walk start?",
          type: "single",
          options: ["18:30", "19:30"],
        },
      ]),
    } as TranscriptPart,
  ]),
];

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
  // The guardian's main chat, which Chat and `/` open at /message.
  session(CONCIERGE_CHAT_ID, "Main chat", "default", CONCIERGE_AGENT_ID),
  // Topic chats, which the Concierge section lists under the main chat.
  session("mock-topic-travel", "Travel planning", "default", CONCIERGE_AGENT_ID),
  session("mock-topic-news", "Weekly news digest", "default", CONCIERGE_AGENT_ID),
  // Kept on ChatGPT by a card's switch: it shows the pinned hint.
  {
    ...session(PROVIDER_CARDS_CHAT_ID, "Provider failure cards", "default", CONCIERGE_AGENT_ID),
    followsDefault: false,
    pinnedModel: { by: "kept", providerId: "openai", selection: null, model: "gpt-6-luna" },
  },
  session(CARD_WIDTHS_CHAT_ID, "Card widths", "default", CONCIERGE_AGENT_ID),
  ...curatedChats.map((chat) => session(chat.id, chat.name, chat.project)),
  // One chat per sidebar mark: running, failed, done with new replies, waiting.
  {
    ...session("mock-chat-1", "Morning brief tweaks", "default"),
    running: true,
    model: "claude-opus-5-5[1m]",
    reasoningEffort: "high",
  },
  {
    ...session("mock-chat-2", "Draft launch email", "website-redesign"),
    unread: true,
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  },
  { ...session("mock-chat-lisbon", "Lisbon flights"), triggerKind: "concierge" },
  // A task chat that is still working, for the chat list's Tasks section.
  {
    ...session("mock-task-running", "Compare standing desks"),
    triggerKind: "concierge",
    running: true,
  },
  { ...session("mock-chat-3", "Weekly planning"), lastTurnFailed: true, model: "gemini-2.5-pro" },
  { ...session("mock-chat-4", "Plumber for the leak"), awaitingGuardian: true },
  {
    ...session("mock-task-question", "Draft launch email"),
    awaitingGuardian: true,
    triggerKind: "concierge",
  },
  { ...session("mock-task-chat-table", "Book a table for Friday"), triggerKind: "concierge" },
  {
    ...session("mock-task-chat-pr-review", "Review the open pull requests"),
    triggerKind: "concierge",
  },
  { ...session("mock-task-chat-visa", "Check the visa appointment"), triggerKind: "concierge" },
  // A chat that works in a folder on another computer groups under that folder.
  {
    ...session("mock-chat-device-folder", "Fix the flaky e2e test"),
    deviceFolder: {
      deviceId: "mac",
      deviceName: "MacBook Pro",
      platform: "macos",
      path: "/Users/ray/code/rome",
    },
  },
];

/** Unread agent messages per topic chat, so the chat list's Concierge dot shows. */
const topicChatUnread: Record<string, number> = { "mock-topic-travel": 2 };

const messageText = (message: ChatMessage): string =>
  (JSON.parse(message.content) as TranscriptPart[])
    .flatMap((b) => (b.type === "text" ? [b.content] : []))
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
      { name: "concierge", description: "Keeps the guardian's chats, tasks and follows" },
    ],
  },
];

/** The loaded agents `GET /api/agents` lists, which the account link picker
 *  offers and its PUT accepts. */
const mockAgentNames = [MAIN_AGENT_ID, "build", "sales:agent"];

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
    visibility: "public",
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
    visibility: "public",
    sideEffects: "read-only",
    requiresApproval: false,
    ownerType: "system",
    ownerId: "system",
    inputSchema: null,
  },
];

const settings: SettingsMap = {
  guardianTimezone: "America/Los_Angeles",
  showAiToolUsage: true,
};

// Projects file-browser fixture. `./file-browser.ts` serves it — the same
// factory the memory dir goes through, since both are the same routes over a
// different root.
const mockBody = (path: string) =>
  `# ${path.split("/").pop()}\n\nMock file content for the dashboard mock mode.\n`;

const projectsTree: MockFsNode[] = [
  outputProjectFolder,
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
 * The Connections tab waits on the Composio status alongside
 * `/api/connections`. In strict E2E mode, unhandled reads hit the 503 fallback
 * and leave that panel in an error state. This fixture keeps the page usable
 * without a backend.
 */
const composioStatus: { composio: ComposioCliStatus } = {
  composio: {
    installed: true,
    loggedIn: true,
    loginPending: false,
    webUrl: null,
    orgId: "demo-workspace",
    testUserId: "mock-guardian",
    error: null,
  },
};

const conversationDefaults: ChatSettings = CHAT_RULE_DEFAULTS;

const DISCORD_FIELDS: ChatSettingField[] = [
  "enabled",
  "activation.mode",
  "activation.botMessages",
  "activation.whenOthersMentioned",
  "replies.placement",
  "routing.agentName",
  "session.reset",
];

/** A channel on the mock Discord bot, with any values a guardian set on it. */
function discordChannel(
  chatId: string,
  displayName: string,
  containerName: string,
  overrides: PartialChatSettings = {},
): ChatSettingsListItem {
  const configured = Object.keys(overrides).length > 0;
  return {
    availability: "online",
    source: configured ? "configured" : "live",
    snapshot: {
      conversation: {
        ref: { connectionId: "discord-1", chatId: chatId as ChatId },
        connectionKind: "discord",
        service: "discord",
        kind: "channel",
        displayName,
        containerName,
      },
      supportedFields: DISCORD_FIELDS,
      effective: mergeSettings(structuredClone(conversationDefaults), overrides),
      overrides: structuredClone(overrides),
      ...(configured
        ? {
            updatedAt: "2026-11-18T09:30:00.000Z",
            updatedBy: { kind: "guardian" as const, displayName: "Mock Guardian" },
          }
        : {}),
    },
  };
}

const conversationSettings: { items: ChatSettingsListItem[] } = {
  items: [
    {
      availability: "online",
      source: "configured",
      snapshot: {
        conversation: {
          ref: { connectionId: "discord-1", chatId: "engineering" as ChatId },
          connectionKind: "discord",
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
    discordChannel("general", "general", "Rome", { activation: { mode: "all" } }),
    discordChannel("launch", "launch-planning", "Rome", { routing: { agentName: "pm-assistant" } }),
    discordChannel("random", "random", "Rome", { enabled: false }),
    discordChannel("announcements", "announcements", "Rome"),
    discordChannel("design", "design", "Rome"),
    discordChannel("standup", "standup", "Rome"),
    discordChannel("support", "customer-support", "Rome Community", {
      replies: { placement: "inline" },
    }),
    discordChannel("welcome", "welcome", "Rome Community"),
    discordChannel("feedback", "feedback", "Rome Community"),
    discordChannel("showcase", "showcase", "Rome Community"),
    {
      availability: "offline",
      source: "known",
      snapshot: {
        conversation: {
          ref: { connectionId: "telegram-1", chatId: "dm-42" as ChatId },
          connectionKind: "telegram",
          service: "telegram",
          kind: "dm",
          displayName: "Ray",
          containerName: undefined,
        },
        // A direct message offers only the session reset.
        supportedFields: ["session.reset"],
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
function mergeSettings<T extends object>(base: T, patch: PartialChatSettings): T {
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

/** A server icon for the mock, drawn inline so the mock needs no network. */
const MOCK_SERVER_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6f5e"/><stop offset="1" stop-color="#7cc4a4"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><path d="M18 70 L40 40 L54 58 L64 46 L80 70 Z" fill="#f4efe4"/><circle cx="68" cy="28" r="8" fill="#f4efe4"/></svg>',
)}`;

export const handlers = [
  ...appConnectionAccessHandlers,
  http.get("/api/health", () => HttpResponse.json({ status: "ok" })),
  // A healthy snapshot for the Advanced tab. Identity is already enrolled, so the
  // section shows the account row rather than a reconnect prompt.
  http.get("/api/diagnosis", () =>
    HttpResponse.json({
      status: "ok",
      checkedAt: new Date().toISOString(),
      uptimeSeconds: 3 * 86_400 + 4 * 3_600 + 12 * 60,
      build: {
        version: "1.1.154",
        sha: "c2f71ed6",
        builtAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
      upgradedSinceLastBoot: false,
      previousVersion: null,
      instance: { auth: "ok", accountId: "acct_mock", instanceId: "inst_mock" },
      database: { ok: true },
      relay: { configured: true, depositUrlConfigured: true },
      channels: ["telegram", "webchat"],
      apps: { total: 12, failed: [], broken: [] },
      resources: {
        memory: { limitBytes: 4 * 1024 ** 3, availableBytes: 2.6 * 1024 ** 3, short: false },
        disk: { totalBytes: 40 * 1024 ** 3, freeBytes: 21 * 1024 ** 3, low: false },
      },
    }),
  ),
  http.get("/api/bootstrap", () => HttpResponse.json(bootstrap)),
  http.get("/api/auth/me", () => HttpResponse.json(identity)),
  // A fresh code each time, in the shape core gives one, valid for ten minutes.
  http.post("/api/account-codes", () => {
    const letters = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    const group = () =>
      Array.from({ length: 6 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
    const issued: AccountCodeIssued = {
      code: `ROME-${group()}-${group()}`,
      expiresInSeconds: 600,
    };
    return HttpResponse.json(issued);
  }),
  http.get("/api/chat/sessions", () => HttpResponse.json(chatSessions)),
  // The Concierge: the guardian's main chat, and the topic chats started here.
  http.get("/api/concierge/session", () => HttpResponse.json({ id: CONCIERGE_CHAT_ID, unread: 0 })),
  http.put("/api/concierge/timezone", () => new HttpResponse(null, { status: 204 })),
  http.get("/api/concierge/chats", () =>
    HttpResponse.json({
      chats: chatSessions
        .filter((s) => s.agentName === CONCIERGE_AGENT_ID && !s.archivedAt)
        .sort(
          (a, b) =>
            Number(b.id === CONCIERGE_CHAT_ID) - Number(a.id === CONCIERGE_CHAT_ID) ||
            a.createdAt.localeCompare(b.createdAt),
        )
        // Mock mode runs no turns, so every chat is idle.
        .map((s) => ({
          id: s.id,
          name: s.name,
          main: s.id === CONCIERGE_CHAT_ID,
          unread: topicChatUnread[s.id] ?? 0,
          activity: { kind: "idle" as const },
        })),
    } satisfies ConciergeChatsResponse),
  ),
  http.post("/api/concierge/chats", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    const id = `mock-topic-${chatSessions.length + 1}`;
    transcripts[id] = [];
    chatSessions.push(session(id, body.name?.trim() ?? "", "default", CONCIERGE_AGENT_ID));
    return HttpResponse.json(
      { id, name: body.name?.trim() ?? "", main: false, unread: 0 },
      {
        status: 201,
      },
    );
  }),
  // Mock mode runs no turns and follows nothing, so a topic chat has nothing to move or stop.
  http.get("/api/concierge/chats/:chatId/follows-and-tasks", () =>
    HttpResponse.json({ follows: [], openTasks: [] } satisfies ConciergeChatWorkResponse),
  ),
  // Held open without events: mock mode runs no turns, so no chat's activity changes.
  http.get("/api/concierge/activity/events", () => {
    const stream = new ReadableStream({ start() {} });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
  }),
  // Held open without events: the fixture's running flags never change.
  http.get("/api/chat/status/events", () => {
    const stream = new ReadableStream({ start() {} });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
  }),
  http.get("/api/chat/sessions/search", ({ request }) => {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return HttpResponse.json(searchMatches(query));
  }),
  http.get("/api/chat/agents", () => HttpResponse.json(chatAgents)),
  http.get("/api/skills", () => HttpResponse.json({ skills })),
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
  http.post("/api/ai-tools/provider-failures/:messageId/switch", async ({ params, request }) => {
    const change = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!change)
      return HttpResponse.json({ error: "A provider or a model is required" }, { status: 400 });
    return settleProviderCard(String(params.messageId), change)
      ? HttpResponse.json({ ok: true })
      : HttpResponse.json({ error: "No open card in that message" }, { status: 409 });
  }),
  http.post("/api/ai-tools/provider-failures/:messageId/continue", ({ params }) =>
    settleProviderCard(String(params.messageId), null)
      ? HttpResponse.json({ ok: true })
      : HttpResponse.json({ error: "No open card in that message" }, { status: 409 }),
  ),
  http.get("/api/chat/sessions/:sessionId/messages", ({ params, request }) => {
    const messages = transcripts[String(params.sessionId)];
    if (!messages) return HttpResponse.json({ error: "Unknown session" }, { status: 404 });
    const query = new URL(request.url).searchParams;
    const limit = Number(query.get("limit"));
    if (!limit) return HttpResponse.json(messages);
    // Pages by message like the server: the cursor is the index of the page's first
    // message, and the traces of the page's turns ride along.
    const said = messages.filter((message) => message.role !== "trace");
    const end = query.has("before") ? Number(query.get("before")) : said.length;
    const start = Math.max(0, end - limit);
    const page = said.slice(start, end);
    const turns = new Set(page.flatMap((message) => (message.turnId ? [message.turnId] : [])));
    const traces = messages.filter(
      (message) => message.role === "trace" && message.turnId && turns.has(message.turnId),
    );
    const shown = new Set([...page, ...traces]);
    return HttpResponse.json({
      messages: messages.filter((message) => shown.has(message)),
      nextCursor: start > 0 ? String(start) : null,
    });
  }),
  // A window of the reply chain the message is in, like the server's: the
  // messages of the chat with the same root, oldest first, the message's id as
  // the cursor for `before` and `after`.
  http.get("/api/chat/sessions/:sessionId/messages/:messageId/thread", ({ params, request }) => {
    const said = (transcripts[String(params.sessionId)] ?? []).filter(
      (message) => message.role !== "trace",
    );
    const anchor = said.find((message) => message.id === params.messageId);
    if (!anchor) return HttpResponse.json({ error: "message_not_found" }, { status: 404 });
    const root = anchor.chatThreadId ?? anchor.id;
    const chain = said.filter((message) => (message.chatThreadId ?? message.id) === root);
    const query = new URL(request.url).searchParams;
    const limit = Number(query.get("limit") ?? 20);
    const before = query.get("before");
    const after = query.get("after");
    const at = chain.findIndex((message) => message.id === (before ?? after ?? anchor.id));
    const from = after ? at + 1 : Math.max(0, at - limit);
    const to = before ? at : at + 1 + limit;
    return HttpResponse.json({
      messages: chain.slice(from, to),
      hasOlder: from > 0,
      hasNewer: to < chain.length,
    });
  }),
  // No turn is ever in flight: the transcripts are static and mock mode has no
  // model behind it, so a session always reads as idle.
  http.get("/api/chat/sessions/:sessionId/turns", () => HttpResponse.json([] as TurnInfo[])),
  // A sent message is only recorded: no turn starts, so nothing answers it. It
  // replies to the message the owner picked, else to nothing.
  http.post("/api/chat/sessions/:sessionId/turns", async ({ params, request }) => {
    const sessionId = String(params.sessionId);
    const messages = transcripts[sessionId];
    if (!messages) return HttpResponse.json({ error: "Unknown session" }, { status: 404 });
    const form = await request.formData();
    const picked = form.get("replyToMessageId");
    const repliesTo = picked ? messages.find((message) => message.id === picked) : undefined;
    const sentAt = new Date().toISOString();
    // A reply shows the quote of what it replies to.
    const original = repliesTo ? JSON.parse(repliesTo.content) : [];
    const quote = original.find((part: { type: string }) => part.type === "text");
    const content = JSON.stringify([
      ...(repliesTo && quote
        ? [
            {
              type: "reply_to",
              messageId: repliesTo.id,
              author: repliesTo.role === "user" ? "guardian" : "agent",
              text: quote.content,
            },
          ]
        : []),
      text(String(form.get("text") ?? "")),
    ]);
    messages.push({
      id: String(form.get("inputId")),
      sessionId,
      turnId: null,
      role: "user",
      content,
      createdAt: sentAt,
      sender: guardianSender,
      chatThreadId: repliesTo
        ? (repliesTo.chatThreadId ?? repliesTo.id)
        : String(form.get("inputId")),
    });
    return HttpResponse.json({
      turnId: null,
      inputId: String(form.get("inputId")),
      inputState: "consumed",
      sessionId,
      startedAt: sentAt,
      content,
    });
  }),
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
  // Pin or unpin a chat from its row menu. Kept in memory, so the chat moves
  // into the Pinned section and stays there until the page reloads.
  http.patch("/api/chat/sessions/:sessionId/pin", async ({ params, request }) => {
    const found = chatSessions.find((s) => s.id === params.sessionId);
    if (!found) return HttpResponse.json({ error: "Unknown session" }, { status: 404 });
    const { pinned } = (await request.json()) as { pinned: boolean };
    found.pinnedAt = pinned ? new Date().toISOString() : null;
    return HttpResponse.json(found);
  }),
  // "Back to default": the chat follows the default again. Kept in memory like the pin.
  http.post("/api/chat/sessions/:sessionId/model/follow-default", ({ params }) => {
    const found = chatSessions.find((s) => s.id === params.sessionId);
    if (!found) return HttpResponse.json({ error: "Unknown session" }, { status: 404 });
    found.followsDefault = true;
    found.pinnedModel = null;
    found.largeModelSelection = null;
    return HttpResponse.json(found);
  }),
  // The open chat's model picker. Kept in memory like the pin.
  http.patch("/api/chat/sessions/:sessionId/model", async ({ params, request }) => {
    const found = chatSessions.find((s) => s.id === params.sessionId);
    if (!found) return HttpResponse.json({ error: "Unknown session" }, { status: 404 });
    try {
      const id = readModelSelectionInput(
        ((await request.json()) as { largeModelSelection?: unknown }).largeModelSelection,
      );
      if (!id)
        return HttpResponse.json({ error: "A model selection is required" }, { status: 400 });
      found.largeModelSelection = id === "auto" ? null : id;
    } catch (error) {
      return HttpResponse.json({ error: String(error) }, { status: 400 });
    }
    return HttpResponse.json(found);
  }),
  // Thumbs on an assistant turn. A chat's rows hydrate from one read once the
  // first scrolls into view, so this only became reachable once sessions had a transcript. Kept in
  // memory rather than always-null so a click actually sticks for the session.
  http.get("/api/chat/sessions/:sessionId/feedback", ({ params }) => {
    const prefix = `${params.sessionId}:`;
    const feedback: Record<string, TurnFeedback> = {};
    for (const [key, value] of turnFeedback) {
      if (key.startsWith(prefix)) feedback[key.slice(prefix.length)] = value;
    }
    return HttpResponse.json({ feedback });
  }),
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
  // Cloud's device list is the slow half of the real answer; the delay shows the
  // menu's placeholder devices.
  http.get("/api/chat/locations", async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return HttpResponse.json({
      projects: projectCatalog,
      devices: pickerDevices,
    } satisfies ChatLocations);
  }),
  http.post("/api/chat/projects", async ({ request }) => {
    const body = (await request.json()) as { name: string };
    const created: ProjectOption = { name: body.name, path: body.name };
    return HttpResponse.json(created);
  }),
  // The Memory page's folder panel leads with this read, so an unhandled
  // status leaves the landing view without a usable fixture. Unlinked, which
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
  // Several surfaces write a setting back on mount (last-used project, composer
  // preferences), so a read-only /api/settings makes the dashboard log a failed
  // write on every load.
  http.put("/api/settings", async ({ request }) => {
    Object.assign(settings, (await request.json()) as SettingsMap);
    return HttpResponse.json(settings);
  }),
  // The auth gate reports the browser timezone once per load; adopt it only
  // while no zone is stored, as core does.
  http.post("/api/settings/guardian-timezone/detected", async ({ request }) => {
    const body = (await request.json()) as { timezone?: string };
    if (typeof settings.guardianTimezone === "string" && settings.guardianTimezone) {
      return HttpResponse.json({ status: "unchanged", tzid: settings.guardianTimezone });
    }
    settings.guardianTimezone = body.timezone;
    return HttpResponse.json({ status: "set", tzid: body.timezone });
  }),
  http.get("/api/system/upgrade/status/snapshot", () => HttpResponse.json(upgradeStatus())),
  http.get("/api/agents", () =>
    HttpResponse.json({ agents: mockAgentNames.map((name) => ({ name })) }),
  ),
  http.get("/api/connections", () => HttpResponse.json(connections)),
  // The iPhone app's battery-and-network capability, as a phone reports it,
  // so a device connect card's page has something to describe.
  http.get("/api/device-connections", () =>
    HttpResponse.json({
      connections: [
        {
          capability: "device",
          title: "Device",
          summary: "Your Rome reads this phone's battery and network.",
          labels: {
            "zh-CN": { title: "设备", summary: "让你的 Rome 读取这部手机的电量和网络。" },
          },
          device: { name: "iPhone" },
          state: "off",
        },
      ],
    }),
  ),
  // Rome's own Discord bot: the servers and accounts bound to this Rome.
  http.get("/api/connections/discord-app/servers", () =>
    HttpResponse.json({
      servers: [
        {
          serverId: "200000000000000001",
          serverName: "Ray's Lab",
          serverIcon: MOCK_SERVER_ICON,
          createdAt: Date.now(),
        },
        {
          serverId: "200000000000000002",
          serverName: "Weekend Hikes",
          serverIcon: null,
          createdAt: Date.now(),
        },
      ],
      users: [{ userId: "300000000000000001", name: "Mock Member", createdAt: Date.now() }],
    }),
  ),
  http.post("/api/connections/discord-app/install-link", () =>
    HttpResponse.json({ url: "https://discord.com/oauth2/authorize?client_id=mock" }),
  ),
  http.delete("/api/connections/discord-app/servers/:serverId", () =>
    HttpResponse.json({ removed: true, left: true }),
  ),
  // An authorized grant is what puts Disconnect on a card, so seeding the three
  // above without this would make every one of those buttons fail locally.
  // Teardown is real here, the way the route runs it: the grant relocks and
  // its identity clears. A channel account that holds no grant then is
  // removed, as core removes it, and a service left with none is offered as a
  // placeholder again. Reconnecting needs a setup ceremony mock mode does not
  // have (see "What mock mode cannot do"), so a disconnect here is one-way
  // until reload — which is the honest depiction of a fixture with no ceremony
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
    connection.state = null;
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
    // Core ends the connection of a service that names its accounts, which
    // the services that take an agent are.
    const unconnectedAccount = Boolean(connection.link);
    if (!unconnectedAccount) return HttpResponse.json({ ok: true, connection });
    const others = connections.connections.filter(
      (candidate) =>
        candidate !== connection && candidate.connectionKind === connection.connectionKind,
    );
    if (others.length > 0) {
      connections.connections.splice(connections.connections.indexOf(connection), 1);
    } else {
      connection.id = null;
      connection.account = null;
      connection.label = connection.connectionKind;
      connection.channel = null;
      connection.agent = null;
    }
    return HttpResponse.json({ ok: true, connection: null });
  }),
  http.get("/api/integrations/composio/status", () => HttpResponse.json(composioStatus)),
  http.get("/api/chat-settings", ({ request }) => {
    const search = new URL(request.url).searchParams;
    const connectionId = search.get("connectionId");
    const query = search.get("query")?.trim().toLocaleLowerCase();
    const changed = search.get("changed") === "true";
    return HttpResponse.json({
      items: conversationSettings.items.filter((item) => {
        const chat = item.snapshot.conversation;
        if (connectionId && chat.ref.connectionId !== connectionId) return false;
        if (changed && Object.keys(item.snapshot.overrides).length === 0) return false;
        if (!query) return true;
        return [chat.connectionKind, chat.containerName, chat.displayName]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(query);
      }),
    });
  }),
  http.post("/api/chat-settings/reset", async ({ request }) => {
    const body = (await request.json()) as { ref: { connectionId: string; chatId: string } };
    const found = conversationSettings.items.find(
      (candidate) =>
        candidate.snapshot.conversation.ref.connectionId === body.ref.connectionId &&
        candidate.snapshot.conversation.ref.chatId === body.ref.chatId,
    );
    if (!found) return HttpResponse.json({ error: "Unknown conversation" }, { status: 404 });
    found.source = "live";
    found.snapshot.overrides = {};
    found.snapshot.effective = chatRuleDefaultsOf(found.snapshot.conversation.connectionKind);
    return HttpResponse.json(found.snapshot);
  }),
  // Auto-save writes through on every edit, so mock mode needs a real write
  // path or the dashboard would toast an error on each change.
  http.patch("/api/chat-settings", async ({ request }) => {
    const body = (await request.json()) as {
      ref: { connectionId: string; chatId: string };
      set: PartialChatSettings;
      clear?: string[];
    };
    const found = conversationSettings.items.find(
      (candidate) =>
        candidate.snapshot.conversation.ref.connectionId === body.ref.connectionId &&
        candidate.snapshot.conversation.ref.chatId === body.ref.chatId,
    );
    if (!found) return HttpResponse.json({ error: "Unknown conversation" }, { status: 404 });
    found.snapshot.effective = mergeSettings(found.snapshot.effective, body.set);
    found.snapshot.overrides = mergeSettings(found.snapshot.overrides, body.set);
    // Core stores a pin to main as null, and clearing the agent choice (the
    // only clear the dashboard sends) leaves the conversation with none.
    const agentName = body.set.routing?.agentName;
    if (agentName === "main" || agentName === MAIN_AGENT_ID) {
      found.snapshot.overrides.routing = { ...found.snapshot.overrides.routing, agentName: null };
      found.snapshot.effective.routing.agentName = null;
    }
    if (body.clear?.includes("routing.agentName")) {
      delete found.snapshot.overrides.routing;
      found.snapshot.effective.routing.agentName = null;
    }
    found.source = "configured";
    found.snapshot.updatedAt = new Date().toISOString();
    found.snapshot.updatedBy = { kind: "guardian", displayName: identity.displayName ?? undefined };
    return HttpResponse.json(found.snapshot);
  }),
  // Per-surface fixture modules. Each owns a disjoint slice of the API and
  // orders its own routes internally, so they can be appended in any order —
  // MSW's first-match rule only bites within a path family.
  ...appHandlers,
  ...taskListHandlers,
  ...chatOutputHandlers,
  ...activityHandlers,
  ...assistantHandlers,
  ...routineHandlers,
  // The session inventory behind /sessions/all, over the same four seeded
  // chats the conversation routes serve — one inventory row per chat, its run
  // and message counts read off that chat's transcript.
  ...sessionQueryHandlers(chatSessions, transcripts),
  ...shareHandlers(chatSessions, transcripts),
  ...settingsHandlers,
  ...connectorHandlers,
  ...mealPlannerHandlers,
  ...recordedAppHandlers,
  ...appKeysHandlers,
  ...vaultHandlers,
  ...liveEventsHandlers,
  ...nodeConsoleHandlers,
  // The two file-browser surfaces, each an in-memory filesystem: the projects
  // dir and the memory dir.
  ...projectFileHandlers,
  ...memoryFileHandlers,
];

export const strictE2eHandlers = [
  http.post("/api/chat/sessions", () =>
    HttpResponse.json({ error: "/api/chat/sessions is unavailable in mock mode" }, { status: 503 }),
  ),
  http.post("/api/auth/login", () => HttpResponse.json({ error: "Login failed" }, { status: 401 })),
  http.all("/api/*", ({ request }) =>
    HttpResponse.json(
      { error: `Unmocked API request: ${request.method} ${new URL(request.url).pathname}` },
      { status: 503 },
    ),
  ),
];
