import { validateCustomAnthropicEnv } from "@rome/api-types/anthropic-compatible-env";
import {
  listAnthropicCompatibleProviderSummaries,
  type AnthropicCompatibleProviderSummary,
} from "@rome/api-types/anthropic-compatible-providers";
import { http, HttpResponse } from "msw";
import type { ComputerUseStatus } from "@rome/api-types/computer-use";
import type {
  AIToolStatus,
  AnthropicCompatibleConfiguredSummary,
} from "@/components/ai-tools-panel";
import type {
  FavorActionRequestSyncPage,
  FavorActionRequestView,
  FavorBalanceView,
  FavorLedgerEntryView,
  FavorLedgerPage,
  FavorRechargePackList,
  FavorRechargePackView,
} from "@rome/api-types/favors";

// Settings-page fixtures: the AI Tools tab and the access-control sections of
// Advanced. Both are read-modify-write surfaces, so the stores below are mutable
// and the write routes are real — a toggle that returned a fixed payload would
// leave the control snapping back on the next read.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fixture clock. Anything the UI compares against "now" — a quota reset, a
 *  next run — has to be generated at load or it decays into the past. */
const fromNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const disconnectedBrowserLastSeen = fromNow(-2 * HOUR);

// ── AI Tools ───────────────────────────────────────────

/**
 * The two first-party CLIs in their two interesting states. Claude is connected
 * and reporting usage, so the panel's quota meters have data; Codex holds
 * credentials that the server proved revoked, which is the `needsReauth` badge —
 * a distinct state from plain "not connected" and the only one that offers a
 * re-login rather than a first login.
 */
const aiToolStatus: Record<string, AIToolStatus> = {
  claude: {
    loggedIn: true,
    email: "guardian@example.com",
    authMethod: "claudeai",
    accountType: "max",
    usage: {
      checkedAt: fromNow(-5 * MINUTE),
      source: "claude-cli",
      // Windows are anchored to load, not to a date. A quota that resets in the
      // past reads as expired and the panel drops the countdown entirely, so a
      // literal timestamp would silently stop exercising these meters the day
      // after it was written.
      fiveHour: { usedPercent: 42, remainingPercent: 58, resetsAt: fromNow(3 * HOUR) },
      sevenDay: { usedPercent: 71, remainingPercent: 29, resetsAt: fromNow(4 * DAY) },
    },
  },
  codex: {
    loggedIn: false,
    email: "guardian@example.com",
    authMethod: "chatgpt",
    needsReauth: true,
  },
};

// The real catalog, not a copy of it. Building the summaries through the same
// function the route calls means a provider added, renamed or repointed in core
// shows up here for free — and an id that does not exist cannot be typed.
const anthropicProviders: AnthropicCompatibleProviderSummary[] =
  listAnthropicCompatibleProviderSummaries();

// Starts unconfigured: a configured Anthropic-compatible provider takes over
// the Claude row, which would hide the subscription state seeded above. The
// configured branch is one dialog away, and the PUT below makes it stick.
let configuredAnthropic: AnthropicCompatibleConfiguredSummary | null = null;

// ── Access control ─────────────────────────────────────

interface PublicAccessConfig {
  enableAccessControl: boolean;
  allowedApps: string[];
  cloudEmailAccess: Record<string, string[]>;
}

/**
 * App-level access policy. Exported because the app cards project their
 * `accessMode` / `isPublic` / `cloudAllowedEmails` from it rather than carrying
 * their own copy — the access dialog writes here, and the next `/api/apps` read
 * has to agree with what it wrote.
 */
export const publicAccess: { config: PublicAccessConfig } = {
  config: {
    // Off: turning it on requires a reachable tailnet, which this instance has
    // no fixture for. The per-app allowances below are independent of it.
    enableAccessControl: false,
    allowedApps: ["notes"],
    cloudEmailAccess: { "morning-brief": ["partner@example.com"] },
  },
};

/** Who may reach the dashboard itself over Rome Cloud, independent of any app. */
const dashboardAccess: { cloudEmailAccess: string[] } = {
  cloudEmailAccess: ["partner@example.com", "sitter@example.com"],
};

// No tailnet, matching the `/api/tailscale/devices` fixture that already
// reports Tailscale unconfigured. A seeded hostname is worse than useless here:
// the page proves reachability by fetching `https://<dns>/api/health` on that
// *other* origin, which no service worker can answer, so it would fail every
// 5s forever — and enabling access control from a different host hands the
// session off by navigating there, out of mock mode entirely. Unconfigured is
// both self-consistent and the state a developer machine is actually in.
const tailnet = {
  tailnetDns: null,
  httpsEnabled: false,
  certReady: false,
  certError: null,
};

// ── Favors ─────────────────────────────────────────────

const FAVOR_USER_ID = "mock-guardian";

/** Fills the fields the tab never reads, so a request fixture states only what
 *  distinguishes it. */
function favorRequest(
  overrides: Pick<FavorActionRequestView, "id" | "actionName" | "amount" | "createdAt"> &
    Partial<FavorActionRequestView>,
): FavorActionRequestView {
  return {
    payerUserId: FAVOR_USER_ID,
    requestorUserId: "mock-housemate",
    recipientUserId: FAVOR_USER_ID,
    requesterInstanceId: null,
    requesterAppId: "groceries",
    requesterAppIdentity: { displayName: "Groceries" },
    definitionHash: "sha256:mock-definition",
    actionRefHash: `sha256:mock-action-ref-${overrides.id}`,
    displayPayload: {},
    attribution: {},
    taskRef: null,
    status: "pending",
    dispatchStatus: "blocked",
    dispatchAttemptCount: 0,
    dispatchClaimExpiresAt: null,
    idempotencyKey: `mock-idempotency-${overrides.id}`,
    failureReason: null,
    expiresAt: fromNow(22 * HOUR),
    decidedAt: null,
    settledAt: null,
    queuedAt: null,
    dispatchedAt: null,
    completedAt: null,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

// The pending request is what makes the pay/decline branch reachable. Its
// `displayPayload` deliberately carries no `title`, which is the case that falls
// back to `actionName` — the field the page reads straight off the wire. The two
// settled requests are what the ledger's debits below point at.
const favorActionRequests: FavorActionRequestView[] = [
  favorRequest({
    id: "favor-request-1",
    actionName: "place_grocery_order",
    amount: 120,
    displayPayload: { summary: "Weekly produce box from the co-op." },
    createdAt: fromNow(-2 * HOUR),
  }),
  favorRequest({
    id: "favor-request-2",
    actionName: "book_house_cleaning",
    amount: 1800,
    displayPayload: { title: "House cleaning", summary: "Fortnightly deep clean." },
    status: "settled",
    dispatchStatus: "succeeded",
    createdAt: fromNow(-6 * DAY),
    decidedAt: fromNow(-6 * DAY),
    settledAt: fromNow(-6 * DAY),
    queuedAt: fromNow(-6 * DAY),
    dispatchedAt: fromNow(-6 * DAY),
    completedAt: fromNow(-6 * DAY),
  }),
  favorRequest({
    id: "favor-request-3",
    actionName: "renew_transit_pass",
    amount: 350,
    displayPayload: { title: "Transit pass" },
    status: "settled",
    dispatchStatus: "succeeded",
    createdAt: fromNow(-12 * DAY),
    decidedAt: fromNow(-12 * DAY),
    settledAt: fromNow(-12 * DAY),
    queuedAt: fromNow(-12 * DAY),
    dispatchedAt: fromNow(-12 * DAY),
    completedAt: fromNow(-12 * DAY),
  }),
];

// Newest first, the order a cursor-paginated ledger returns. Every settled
// request above carries its debit here, so the ledger the tab shows accounts for
// the whole balance rather than only the credits.
const favorLedger: FavorLedgerEntryView[] = [
  {
    id: "favor-ledger-1",
    userId: FAVOR_USER_ID,
    actionRequestId: null,
    rechargeId: "recharge-1",
    amount: 2400,
    kind: "recharge",
    operationKey: "recharge:recharge-1",
    metadata: {},
    createdAt: fromNow(-3 * DAY),
  },
  ...favorActionRequests
    .filter((request) => request.status === "settled")
    .map(
      (request): FavorLedgerEntryView => ({
        id: `favor-ledger-debit-${request.id}`,
        userId: FAVOR_USER_ID,
        actionRequestId: request.id,
        rechargeId: null,
        amount: -request.amount,
        kind: "action_request_debit",
        operationKey: `action_request_debit:${request.id}`,
        metadata: { actionName: request.actionName },
        createdAt: request.settledAt ?? request.createdAt,
      }),
    ),
  {
    id: "favor-ledger-2",
    userId: FAVOR_USER_ID,
    actionRequestId: null,
    rechargeId: null,
    amount: 1000,
    kind: "initial_grant",
    operationKey: `initial_grant:${FAVOR_USER_ID}`,
    metadata: {},
    createdAt: fromNow(-30 * DAY),
  },
];

// Projected from the ledger rather than stated beside it. The balance and the
// ledger render on the same tab, so hand-written totals are a fixture that can
// disagree with itself.
const favorBalance: FavorBalanceView = {
  userId: FAVOR_USER_ID,
  available: favorLedger.reduce((total, entry) => total + entry.amount, 0),
  lifetimeEarned: favorLedger
    .filter((entry) => entry.amount > 0)
    .reduce((total, entry) => total + entry.amount, 0),
  lifetimeSpent: favorLedger
    .filter((entry) => entry.amount < 0)
    .reduce((total, entry) => total - entry.amount, 0),
  updatedAt: fromNow(-2 * HOUR),
};

const favorPacks: FavorRechargePackView[] = [
  { id: "pack-1000", favors: 1000, displayPrice: "$10" },
  { id: "pack-5000", favors: 5000, displayPrice: "$45" },
];

export const settingsHandlers = [
  http.get("/api/computer-use", () =>
    HttpResponse.json({
      daemon: { status: "running", version: "1.8.8" },
      checkedAt: new Date().toISOString(),
      connections: [
        {
          id: "rome-browser",
          name: "Rome browser",
          cli: "opencli",
          status: "connected",
          version: "1.0.24",
          lastSeenAt: fromNow(-10_000),
        },
        {
          id: "mac-browser",
          name: "Mac Chrome",
          cli: "opencli",
          status: "disconnected",
          version: "1.0.24",
          lastSeenAt: disconnectedBrowserLastSeen,
        },
      ],
    } satisfies ComputerUseStatus),
  ),
  http.get("/api/ai-tools/status", () =>
    HttpResponse.json({ ...aiToolStatus, anthropicCompatible: configuredAnthropic }),
  ),
  http.get("/api/ai-tools/anthropic-compatible-providers", () =>
    HttpResponse.json({ providers: anthropicProviders, configured: configuredAnthropic }),
  ),
  http.put("/api/ai-tools/anthropic-compatible-credentials", async ({ request }) => {
    const body = (await request.json()) as { provider: string; apiKey?: string; env?: unknown };
    const preset = anthropicProviders.find((provider) => provider.id === body.provider);
    // The real route rejects an unknown provider and a preset with no key. A
    // mock that stored either would report a configuration production refuses.
    if (!preset) {
      return HttpResponse.json({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
    }
    if (preset.kind === "preset" && !body.apiKey?.trim()) {
      return HttpResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    // The custom branch carries an env block instead of a key, and its rules are
    // specific enough (allowed names, size caps, exactly one auth key, a valid
    // base URL) that restating them here would be a second implementation to
    // drift. Same validator the route runs.
    let customEnv: Record<string, string> | undefined;
    if (preset.kind === "custom") {
      const validated = validateCustomAnthropicEnv(body.env);
      if (!validated.ok) return HttpResponse.json({ error: validated.error }, { status: 400 });
      customEnv = validated.env;
    }
    configuredAnthropic = {
      // `preset.id`, not the raw body: the request's provider is an unvalidated
      // string until the catalog lookup above vouches for it.
      provider: preset.id,
      providerName: preset.name,
      hasApiKey: Boolean(body.apiKey?.trim()) || customEnv !== undefined,
      updatedAt: new Date().toISOString(),
      ...(customEnv ? { env: customEnv } : {}),
    };
    return HttpResponse.json({ configured: configuredAnthropic });
  }),
  http.delete("/api/ai-tools/anthropic-compatible-credentials", () => {
    configuredAnthropic = null;
    return HttpResponse.json({ configured: null });
  }),
  // Logout is the one AI-tool write that is non-interactive; the login flows are
  // device/browser round-trips with no fixture equivalent, so they stay unhandled
  // and their modals surface their own failure.
  http.post("/api/ai-tools/:provider/logout", ({ params }) => {
    const provider = String(params.provider);
    const status = aiToolStatus[provider];
    if (!status) return HttpResponse.json({ error: "Unknown provider" }, { status: 404 });
    aiToolStatus[provider] = { loggedIn: false };
    return HttpResponse.json({ ok: true });
  }),
  http.get("/api/public-access", () => HttpResponse.json(publicAccess.config)),
  http.put("/api/public-access", async ({ request }) => {
    publicAccess.config = (await request.json()) as PublicAccessConfig;
    return HttpResponse.json(publicAccess.config);
  }),
  http.get("/api/dashboard-access", () => HttpResponse.json(dashboardAccess)),
  http.put("/api/dashboard-access", async ({ request }) => {
    const body = (await request.json()) as { cloudEmailAccess: string[] };
    dashboardAccess.cloudEmailAccess = body.cloudEmailAccess;
    return HttpResponse.json(dashboardAccess);
  }),
  http.get("/api/tailnet", () => HttpResponse.json(tailnet)),
  http.get("/api/favors/balance", () => HttpResponse.json(favorBalance)),
  // The envelopes carry the cursors the real routes return, even though the
  // Favors tab reads only `requests` and `entries` — a fixture that drops them
  // would understate the contract for the next reader of this surface.
  http.get("/api/favors/action-requests", () =>
    HttpResponse.json({
      requests: favorActionRequests,
      nextCursor: "",
    } satisfies FavorActionRequestSyncPage),
  ),
  http.get("/api/favors/ledger", () =>
    HttpResponse.json({ entries: favorLedger, nextCursor: null } satisfies FavorLedgerPage),
  ),
  // GET only: the recharge POST starts a payment redirect, a third-party
  // round-trip with no fixture equivalent, so it stays unhandled like the
  // AI-tool login flows.
  http.get("/api/favors/recharge", () =>
    HttpResponse.json({ packs: favorPacks } satisfies FavorRechargePackList),
  ),
];
