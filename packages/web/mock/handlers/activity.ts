import { pairingPayload, PAIRING_HISTORY_PAGE_SIZE } from "@rome/api-types/approvals";
import { pairingFixtures, PAIRING_FIXTURE_CODE } from "../../src/pages/dev/pairing-fixtures";
import { http, HttpResponse } from "msw";
import type { ApprovalRecord } from "@/lib/chat-types";
import type {
  ActionExecution,
  Approval,
  ExecutionGroup,
  WebhookInvocation,
} from "@/pages/ActivityPage";

// Activity-page fixtures: the three independent feeds the page merges
// (approvals, action-execution trees, webhook invocations) plus the writes that
// resolve them. Every status the page styles is represented at least once, so
// the filter chips all have something to select and the status vocabulary can
// be read against real rows.

const GUARDIAN = { kind: "guardian" as const, userId: "mock-guardian", via: "cookie" as const };

// `type` is a closed set of three lifecycles (see @rome/api-types/approvals),
// and each has one creator: the action engine writes `action_execution` — the
// only kind the resolve route queues and the only kind offering a retry — while
// the inbox app writes `outgoing_message` for a sent-message audit record and
// `person_mapping` when it maps an unknown sender. What is being approved lives
// in the payload and the description, exactly as it does on the server;
// `sensitive_message` is a *preview* kind, a different contract, and belongs on
// the chat card rather than here.
//
// One approval is left pending on purpose: it is the only row whose approve /
// reject controls are live, and the in-chat ApprovalCard resolves against this
// same store (see `approvalCardId`), so approving from either surface is
// visible in the other.
const approvals: Approval[] = [
  ...pairingFixtures(),
  {
    id: "approval-1",
    type: "action_execution",
    status: "pending",
    requestedBy: "main",
    description: 'Action "send_message" requires guardian approval',
    payload: {
      actionName: "send_message",
      args: {
        person: "Ray",
        channel: "telegram",
        text: "The plumber is booked for Thursday 9am — does that still work for you?",
      },
      rootActionName: "send_message",
      rootExecutionId: "exec-4",
      sessionId: "mock-chat-4",
      agentName: "main",
    },
    createdAt: "2026-08-05T08:41:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    executedAt: null,
    executionError: null,
  },
  {
    id: "approval-2",
    type: "action_execution",
    status: "approved",
    requestedBy: "main",
    description: 'Action "place_order" requires guardian approval',
    payload: {
      actionName: "place_order",
      args: { vendor: "Home Supply Co.", item: "Water filters", amountUsd: 38.4 },
      rootActionName: "place_order",
      rootExecutionId: "exec-6",
    },
    createdAt: "2026-08-04T17:02:00.000Z",
    resolvedAt: "2026-08-04T17:09:00.000Z",
    resolvedBy: "mock-guardian",
    executedAt: "2026-08-04T17:09:04.000Z",
    executionError: null,
  },
  {
    // Approved but its execution failed afterwards — the page distinguishes
    // "execution_failed" from "rejected". The retry control is gated on the
    // `action_execution` type as well as that status, so a differently-typed
    // approval would show the error with no way to act on it.
    id: "approval-3",
    type: "action_execution",
    status: "approved",
    requestedBy: "briefer",
    description: 'Action "calendar_create_event" requires guardian approval',
    payload: {
      actionName: "calendar_create_event",
      args: { calendar: "family", title: "School forms due", date: "2026-08-08" },
      rootActionName: "daily_summary",
      rootExecutionId: "exec-1",
    },
    createdAt: "2026-08-04T09:15:00.000Z",
    resolvedAt: "2026-08-04T09:16:00.000Z",
    resolvedBy: "mock-guardian",
    executedAt: null,
    executionError: "Calendar API returned 503 (upstream unavailable)",
  },
  {
    id: "approval-4",
    type: "outgoing_message",
    status: "rejected",
    requestedBy: "envoy",
    description: "Envoy reply to an unknown sender",
    payload: {
      response: "Sure, what time works for you?",
      channel: "whatsapp",
      threadId: "+15550001111",
      channelUserId: "+15550001111",
    },
    createdAt: "2026-08-03T21:30:00.000Z",
    resolvedAt: "2026-08-03T21:44:00.000Z",
    resolvedBy: "mock-guardian",
    executedAt: null,
    executionError: null,
  },
  {
    // The third lifecycle: written by the inbox app when it maps an unknown
    // sender to an existing person. Auto-approved on creation — rejecting it is
    // how the guardian undoes the mapping, which is why it is listed at all.
    id: "approval-6",
    type: "person_mapping",
    status: "auto_approved",
    requestedBy: "system",
    description: 'Auto-mapped Ray (telegram:5550111) to existing person "Ray Consuelo"',
    payload: {
      action: "auto_mapped_existing",
      personId: "person-ray",
      personDisplayName: "Ray Consuelo",
      channel: "telegram",
      channelUserId: "5550111",
      senderDisplayName: "Ray",
    },
    createdAt: "2026-08-03T18:20:00.000Z",
    resolvedAt: "2026-08-03T18:20:00.000Z",
    resolvedBy: "system",
    executedAt: null,
    executionError: null,
  },
  {
    id: "approval-5",
    type: "action_execution",
    status: "auto_approved",
    requestedBy: "main",
    description: 'Action "web_fetch" requires guardian approval',
    payload: {
      actionName: "web_fetch",
      args: { url: "https://example.com/pricing" },
      rootActionName: "web_fetch",
      rootExecutionId: "exec-8",
    },
    createdAt: "2026-08-03T14:12:00.000Z",
    resolvedAt: "2026-08-03T14:12:00.000Z",
    resolvedBy: "policy:read-only-web",
    executedAt: "2026-08-03T14:12:01.000Z",
    executionError: null,
  },
];

/** The approval the chat transcript's approval_card points at. Sharing one row
 *  keeps the card and the Activity feed from telling different stories. */
export const approvalCardId = "approval-1";

const execution = (
  fields: Pick<ActionExecution, "id" | "actionName" | "status" | "startedAt"> &
    Partial<ActionExecution>,
): ActionExecution => ({
  rootExecutionId: fields.rootExecutionId ?? fields.id,
  actionType: null,
  args: {},
  error: null,
  durationMs: null,
  initiator: "main",
  actor: GUARDIAN,
  parentId: null,
  finishedAt: null,
  cancelRequestedAt: null,
  cancellationReason: null,
  createdAt: fields.startedAt,
  ...fields,
});

// Roots with their children, mirroring the tree the real route returns. The
// nesting is what the page's expandable rows exist for, so at least one root
// carries a multi-step chain and one carries a failing child.
const executionGroups: ExecutionGroup[] = [
  {
    rootExecution: execution({
      id: "exec-1",
      actionName: "daily_summary",
      actionType: "custom",
      status: "success",
      startedAt: "2026-08-05T07:00:00.000Z",
      finishedAt: "2026-08-05T07:00:11.400Z",
      durationMs: 11_400,
      initiator: "routine:morning-brief",
      args: { sections: ["inbox", "weather"] },
    }),
    children: [
      execution({
        id: "exec-1a",
        rootExecutionId: "exec-1",
        parentId: "exec-1",
        actionName: "inbox_scan",
        status: "success",
        startedAt: "2026-08-05T07:00:01.000Z",
        finishedAt: "2026-08-05T07:00:05.900Z",
        durationMs: 4_900,
      }),
      execution({
        id: "exec-1b",
        rootExecutionId: "exec-1",
        parentId: "exec-1",
        actionName: "weather_forecast",
        status: "success",
        startedAt: "2026-08-05T07:00:06.000Z",
        finishedAt: "2026-08-05T07:00:07.300Z",
        durationMs: 1_300,
        args: { location: "home", days: 1 },
      }),
    ],
  },
  {
    rootExecution: execution({
      id: "exec-2",
      actionName: "ledger_push",
      status: "error",
      startedAt: "2026-08-05T06:30:00.000Z",
      finishedAt: "2026-08-05T06:30:02.100Z",
      durationMs: 2_100,
      error: "Action registration failed: `ledger_push` declared an unknown input schema.",
      initiator: "routine:ledger-sync",
    }),
    children: [],
  },
  {
    // Still running, so the page's live status treatment (and the cancel
    // control, which is only offered on a running root) has a target.
    rootExecution: execution({
      id: "exec-3",
      actionName: "web_search",
      status: "running",
      startedAt: "2026-08-05T09:04:12.000Z",
      args: { query: "school district calendar 2026" },
    }),
    children: [],
  },
  {
    rootExecution: execution({
      id: "exec-4",
      actionName: "send_message",
      status: "pending_approval",
      startedAt: "2026-08-05T08:41:00.000Z",
      args: { person: "Ray", channel: "telegram" },
    }),
    children: [],
  },
  {
    rootExecution: execution({
      id: "exec-5",
      actionName: "note_create",
      status: "cancelled",
      startedAt: "2026-08-04T22:15:00.000Z",
      finishedAt: "2026-08-04T22:15:30.000Z",
      durationMs: 30_000,
      cancelRequestedAt: "2026-08-04T22:15:29.000Z",
      cancellationReason: "Cancelled by guardian",
      actor: { kind: "visitor", accountId: "acct-visitor-1", email: "sitter@example.com" },
    }),
    children: [],
  },
];

// The callback lifecycle is the axis here: a webhook can succeed while its
// callback delivery fails, so `status` and `callbackStatus` are seeded
// disagreeing on one row.
const webhookInvocations: WebhookInvocation[] = [
  {
    executionId: "hook-1",
    actionName: "expense_log",
    args: { amountUsd: 12.5, category: "groceries" },
    callbackUrl: "https://hooks.example.com/rome/expense",
    status: "success",
    result: { entryId: "exp-8842" },
    error: null,
    callbackStatus: "succeeded",
    callbackAttemptedAt: "2026-08-05T05:12:03.000Z",
    callbackDeliveredAt: "2026-08-05T05:12:03.400Z",
    callbackResponseStatus: 200,
    callbackError: null,
    createdAt: "2026-08-05T05:12:01.000Z",
    updatedAt: "2026-08-05T05:12:03.400Z",
    finishedAt: "2026-08-05T05:12:03.000Z",
  },
  {
    executionId: "hook-2",
    actionName: "note_create",
    args: { title: "Vendor quote" },
    callbackUrl: "https://hooks.example.com/rome/notes",
    status: "success",
    result: { noteId: "note-119" },
    error: null,
    callbackStatus: "failed",
    callbackAttemptedAt: "2026-08-04T19:40:12.000Z",
    callbackDeliveredAt: null,
    callbackResponseStatus: 502,
    callbackError: "Bad Gateway",
    createdAt: "2026-08-04T19:40:10.000Z",
    updatedAt: "2026-08-04T19:40:12.000Z",
    finishedAt: "2026-08-04T19:40:11.000Z",
  },
  {
    executionId: "hook-3",
    actionName: "weather_forecast",
    args: { location: "cabin" },
    callbackUrl: null,
    status: "accepted",
    result: null,
    error: null,
    callbackStatus: "not_requested",
    callbackAttemptedAt: null,
    callbackDeliveredAt: null,
    callbackResponseStatus: null,
    callbackError: null,
    createdAt: "2026-08-05T09:05:00.000Z",
    updatedAt: "2026-08-05T09:05:00.000Z",
    finishedAt: null,
  },
];

function findApproval(id: string): Approval | undefined {
  return approvals.find((approval) => approval.id === id);
}

export const activityHandlers = [
  http.get("/api/approvals", ({ request }) => {
    for (const approval of approvals) {
      const payload = pairingPayload(approval);
      if (payload && approval.status === "pending" && payload.expiresAt <= Date.now()) {
        approval.status = "rejected";
        approval.payload = { ...payload, resolution: "expired" };
        approval.resolvedBy = "system:expiry";
        approval.resolvedAt = new Date().toISOString();
      }
    }
    const offset = Number(new URL(request.url).searchParams.get("pairingHistoryOffset") ?? "0");
    const history = approvals.filter((row) => pairingPayload(row) && row.status !== "pending");
    const current =
      offset === 0
        ? approvals.filter((row) => !pairingPayload(row) || row.status === "pending")
        : [];
    return HttpResponse.json([
      ...current,
      ...history.slice(offset, offset + PAIRING_HISTORY_PAGE_SIZE),
    ]);
  }),
  http.get("/api/approvals/:id/code", ({ params }) => {
    const approval = findApproval(String(params.id));
    const payload = approval && pairingPayload(approval);
    return HttpResponse.json({
      code:
        payload &&
        approval?.status === "pending" &&
        payload.expiresAt > Date.now() &&
        payload.failedAttempts < 5
          ? PAIRING_FIXTURE_CODE
          : null,
    });
  }),
  // Keyed by :id, so it must stay after the collection route above.
  http.get("/api/approvals/:id", ({ params }) => {
    const approval = findApproval(String(params.id));
    if (!approval) return HttpResponse.json({ error: "Unknown approval" }, { status: 404 });
    return HttpResponse.json({
      id: approval.id,
      status: approval.status,
      executionState: approval.executionError
        ? "failed"
        : approval.executedAt
          ? "succeeded"
          : "idle",
      executionError: approval.executionError,
    } satisfies ApprovalRecord);
  }),
  // Must precede the ":intent" route below, which would otherwise match "retry"
  // and reject it as an unknown intent.
  http.post("/api/approvals/:id/retry", ({ params }) => {
    const approval = findApproval(String(params.id));
    if (!approval) return HttpResponse.json({ error: "Unknown approval" }, { status: 404 });
    approval.executionError = null;
    approval.executedAt = new Date().toISOString();
    return HttpResponse.json({ ok: true });
  }),
  http.post("/api/approvals/:id/:intent", async ({ params, request }) => {
    const approval = findApproval(String(params.id));
    if (!approval) return HttpResponse.json({ error: "Unknown approval" }, { status: 404 });
    const intent =
      params.intent === "resolve"
        ? ((await request.json()) as { action?: string }).action
        : String(params.intent);
    if (intent !== "approve" && intent !== "reject") {
      return HttpResponse.json({ error: "Unknown intent" }, { status: 400 });
    }
    // The real route is write-once: a second resolution is a 409, and the
    // ApprovalCard treats that as success (it adopts the stored record), so a
    // fixture that silently re-resolved would hide the branch.
    if (approval.status !== "pending") {
      return HttpResponse.json({ error: "Already resolved" }, { status: 409 });
    }
    approval.status = intent === "approve" ? "approved" : "rejected";
    approval.resolvedAt = new Date().toISOString();
    approval.resolvedBy = "mock-guardian";
    const payload = pairingPayload(approval);
    if (payload)
      approval.payload = { ...payload, resolution: intent === "approve" ? "web" : "rejected" };
    if (intent === "approve" && approval.type === "action_execution")
      approval.executedAt = approval.resolvedAt;
    return HttpResponse.json({ ok: true });
  }),
  // `limit`/`offset` are ignored: the fixture list is shorter than the page's
  // first page, so paginating it would only ever return the same rows.
  http.get("/api/action-executions", () => HttpResponse.json(executionGroups)),
  http.post("/api/action-executions/:id/cancel", ({ params }) => {
    const id = String(params.id);
    const group = executionGroups.find((candidate) => candidate.rootExecution.id === id);
    if (!group) return HttpResponse.json({ error: "Unknown execution" }, { status: 404 });
    const root = group.rootExecution;
    const now = new Date().toISOString();
    root.status = "cancelled";
    root.cancelRequestedAt = now;
    root.cancellationReason = "Cancelled by guardian";
    root.finishedAt = now;
    return HttpResponse.json({ ok: true });
  }),
  http.get("/api/webhook-invocations", () => HttpResponse.json(webhookInvocations)),
];
