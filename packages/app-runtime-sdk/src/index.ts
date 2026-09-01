import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import type { JSONSchema } from "zod/v4/core";

export { z };
export type { JSONSchema };
export * from "./conversation-settings.js";

// Browser-safe package entry point. Node-only CDP helpers live under the `/browser` subpath.

// Telemetry stays behind this bridge so apps do not depend on Core or OpenTelemetry.

export type SpanAttributes = Record<string, unknown>;

export interface TelemetryBridge {
  withRomeSpan<T>(name: string, attrs: SpanAttributes, fn: () => Promise<T>): Promise<T>;
  startRomeSpan(name: string, attrs?: SpanAttributes): void;
  currentSessionId(): string | undefined;
  runWithSession<T>(sessionId: string, fn: () => T): T;
}

const TELEMETRY_BRIDGE_KEY = Symbol.for("rome.appRuntime.telemetryBridge");

type GlobalTelemetryRegistry = typeof globalThis & {
  [TELEMETRY_BRIDGE_KEY]?: TelemetryBridge | undefined;
};

function getBridge(): TelemetryBridge | undefined {
  return (globalThis as GlobalTelemetryRegistry)[TELEMETRY_BRIDGE_KEY];
}

/** Replaces the process-wide telemetry bridge; `null` unregisters it. */
export function setTelemetryBridge(bridge: TelemetryBridge | null): void {
  (globalThis as GlobalTelemetryRegistry)[TELEMETRY_BRIDGE_KEY] = bridge ?? undefined;
}

/**
 * Runs `fn` inside a named span. Without a registered bridge, it runs `fn`
 * without emitting a span.
 */
export function withRomeSpan<T>(
  name: string,
  attrs: SpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  const bridge = getBridge();
  return bridge ? bridge.withRomeSpan(name, attrs, fn) : fn();
}

/**
 * Starts a detached span, or does nothing without a registered bridge. It does
 * not expose the provider's span handle.
 */
export function startRomeSpan(name: string, attrs: SpanAttributes = {}): void {
  getBridge()?.startRomeSpan(name, attrs);
}

/** Current session id from core's AsyncLocalStorage, or `undefined`. */
export function currentSessionId(): string | undefined {
  return getBridge()?.currentSessionId();
}

/**
 * Runs `fn` inside a fresh session context, or without context when no bridge
 * is registered.
 */
export function runWithSession<T>(sessionId: string, fn: () => T): T {
  const bridge = getBridge();
  return bridge ? bridge.runWithSession(sessionId, fn) : fn();
}

/**
 * Wraps `fn` in an `sdk:<methodName>` span and stamps `sdk.method`. Caller
 * attributes take precedence on key collisions.
 */
export async function withSdkSpan<T>(
  methodName: string,
  attrs: SpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  return withRomeSpan(`sdk:${methodName}`, { "sdk.method": methodName, ...attrs }, fn);
}

/**
 * One connectable third-party toolkit. `apiHost` is omitted when the provider
 * uses a connection-specific host.
 */
export interface SupportedConnector {
  toolkit: string;
  displayName: string;
  apiHost?: string;
}

/**
 * Curated connectable toolkits, not the guardian's active connections. Slugs
 * must stay in sync with `rome_apps/connector/app.yaml`; `apiHost` supplies the
 * proxy default, so callers must pass a host when it is absent.
 */
export const SUPPORTED_CONNECTORS: readonly SupportedConnector[] = [
  { toolkit: "gmail", displayName: "Gmail", apiHost: "gmail.googleapis.com" },
  { toolkit: "outlook", displayName: "Outlook", apiHost: "graph.microsoft.com" },
  { toolkit: "googlecalendar", displayName: "Calendar", apiHost: "www.googleapis.com" },
  { toolkit: "github", displayName: "GitHub", apiHost: "api.github.com" },
  { toolkit: "slack", displayName: "Slack", apiHost: "slack.com" },
  { toolkit: "notion", displayName: "Notion", apiHost: "api.notion.com" },
  { toolkit: "googledrive", displayName: "Drive", apiHost: "www.googleapis.com" },
  { toolkit: "googlesheets", displayName: "Sheets", apiHost: "sheets.googleapis.com" },
  { toolkit: "googledocs", displayName: "Docs", apiHost: "docs.googleapis.com" },
  { toolkit: "googleslides", displayName: "Slides", apiHost: "slides.googleapis.com" },
  { toolkit: "googleads", displayName: "Google Ads", apiHost: "googleads.googleapis.com" },
  { toolkit: "dropbox", displayName: "Dropbox", apiHost: "api.dropboxapi.com" },
  { toolkit: "linear", displayName: "Linear", apiHost: "api.linear.app" },
  { toolkit: "discord", displayName: "Discord", apiHost: "discord.com" },
  { toolkit: "linkedin", displayName: "LinkedIn", apiHost: "api.linkedin.com" },
  { toolkit: "metaads", displayName: "Meta Ads", apiHost: "graph.facebook.com" },
  { toolkit: "supabase", displayName: "Supabase" },
  { toolkit: "neon", displayName: "Neon", apiHost: "console.neon.tech" },
  { toolkit: "hubspot", displayName: "HubSpot", apiHost: "api.hubapi.com" },
  { toolkit: "stripe", displayName: "Stripe", apiHost: "api.stripe.com" },
];

export interface ActionConfig {
  name: string;
  type: "system" | "custom";
  description: string;
  entry?: string;
  complexity: "simple" | "moderate" | "complex";
  speed: "fast" | "moderate" | "slow";
  reliability: "high" | "medium" | "low";
  sideEffects: "read-only" | "write";
  requiresApproval?: boolean;
  cancellable?: boolean;
  webhook?: boolean;
  favorRequirement?: FavorRequirementConfig;
}

export interface FavorRequirementConfig {
  amount: number;
  title: string;
  summary?: string;
  displayFields?: Array<{ label: string; from: string }>;
}

/** Opaque reference to a durable Rome-owned session. Apps must pass the whole
 * object to Rome APIs and must not inspect or reconstruct its fields. */
export type RomeSessionType =
  | "webchat"
  | "webchat_handoff"
  | "channel"
  | "action"
  | "fork"
  | "subagent";

export interface RomeSessionRef {
  readonly _romeSessionId: string;
  readonly _type: RomeSessionType;
}

/** A low-volume, caller-facing event explicitly published by an Action. */
export interface ActionEvent {
  readonly type: string;
}

export interface ActionExecutionContext {
  emitActionEvent<TEvent extends ActionEvent>(event: TEvent): void;
}

export interface ActionInvocation<TEvent extends ActionEvent = ActionEvent, TOutput = unknown> {
  readonly events: AsyncIterable<TEvent>;
  readonly result: Promise<ActionResult<TOutput>>;
}

/** Options for an ordinary nested action call. Nested calls share their
 * caller's root execution and cancellation lifetime. The returned promise
 * must be awaited; do not use `void runAction(...)` for nested work. */
export interface RunActionOptions {
  detached?: false;
}

/** Options for dispatching an action as a new root execution whose lifetime
 * is independent from the caller. */
export interface DetachedRunActionOptions {
  detached: true;
}

/** Main-process acceptance receipt for a detached root action. Awaiting this
 * receipt does not await the dispatched action's final result. */
export interface ActionDispatchReceipt {
  executionId: string;
}

export class ActionInvocationEventOverflowError extends Error {
  constructor(readonly capacity: number) {
    super(`Action invocation event buffer exceeded its capacity of ${capacity}`);
    this.name = "ActionInvocationEventOverflowError";
  }
}

export interface Action {
  config: ActionConfig;
  inputSchema?: Record<string, unknown>;
  execute(args: Record<string, unknown>, context?: ActionExecutionContext): Promise<ActionResult>;
  /**
   * Optional preview renderer. Returns a structured payload describing what
   * the action would do, used to build approval cards shown to the guardian.
   * Usually pure over args; may be async when the runtime lazily loads the
   * action implementation before rendering the preview.
   */
  preview?(args: Record<string, unknown>): PreviewPayload | Promise<PreviewPayload | undefined>;
}

export type PreviewPayload =
  | {
      kind: "sensitive_message";
      channel: string;
      threadId: string;
      text: string;
      reason?: string;
    }
  | {
      kind: "generic";
      title: string;
      summary: string;
      fields?: { label: string; value: string }[];
    };

/** Execution was suspended pending guardian approval; the action body has NOT
 * run. When the guardian approves, core re-runs the action for real and the
 * outcome arrives out-of-band (a new agent turn / webhook poll update). */
export interface PendingApproval {
  approvalId: string;
  actionName: string;
  description: string;
}

/**
 * Park the calling agent on a self-contained guardian input. When an
 * agent-callable action returns this, the calling agent is told to wait (it
 * does not receive data); the chat host mounts this app's own component as a
 * first-class assistant block in the transcript (declared in app.yaml under
 * `components:` and registered via the web SDK's `defineComponent`). Best for
 * a structured question card (see the `ask-user` app). The thread is not
 * locked; several inline components can be open at once.
 *
 * Resolves by posting an `interaction_result` (the produced artifact, or
 * `{ dismissed: true }`) on the session, which re-drives the calling agent
 * with a server-built outcome prompt. Control never leaves the calling agent —
 * for a transfer of the floor to another agent, see {@link Handoff}.
 */
export interface PendingInteraction {
  appId: string;
  /**
   * Human-readable rendering of what the component asks for. Only webchat can
   * mount the component; on a messaging channel (or inside a subagent) the
   * calling agent relays this text as prose and the guardian's reply arrives
   * as the next turn.
   */
  promptText: string;
  render: {
    kind: "inline";
    componentId: string;
    props?: Record<string, unknown>;
  };
}

/**
 * Result contract of a handoff's child conversation — what the specialist
 * agent must hand back before control returns to the caller.
 */
export interface HandbackSpec {
  /**
   * JSON Schema the handback artifact must satisfy. The specialist agent gets
   * a `submit_output` tool AJV-validated against it; invalid submissions
   * bounce back as tool errors until they conform.
   */
  schema: Record<string, unknown>;
  /**
   * Optional action the host runs on each submission AFTER the schema passes,
   * for app-specific semantic checks the schema can't express. It receives the
   * candidate payload as its input and must return `{ valid: boolean,
   * errors?: string[] }` in `data`. Invalid (or any validator failure —
   * fail-closed) bounces the submission back to the agent with the errors.
   * Must be read-only: it can run once per submission attempt.
   */
  validate?: string;
}

/**
 * Transfer the floor to another agent. When an agent-callable action returns
 * this, the calling agent suspends and the host opens a dedicated child session
 * the guardian collaborates in with `agentName` (see Workflow Studio's
 * `design_workflow`). The parent thread is locked until control returns.
 *
 * The handoff itself mounts no app surface — the summoned agent brings one up on
 * demand by calling the `show_app` action (e.g. Workflow Studio's author shows
 * its live storyboard once there is a plan to preview). `appId` only names the
 * app that owns the handoff (the host install-checks it).
 *
 * The handback: when `handback` is set, a schema-valid (and, if declared,
 * app-validated) `submit_output` submission renders an approval card in the
 * child session; guardian approval ends the handoff and posts the payload as
 * an `interaction_result` on the parent session, re-driving the caller with a
 * server-built outcome prompt (plus `handbackHint`). Dismissal hands control
 * back with `{ dismissed: true }` and no artifact.
 */
export interface Handoff {
  /** The host rejects the handoff unless this app is installed. */
  appId: string;
  /**
   * Off-webchat fallback. Only webchat can run a handoff; on a messaging
   * channel (or inside a subagent) the calling agent relays this text as prose
   * and the guardian's reply arrives as the next turn.
   */
  promptText: string;
  /**
   * Agent the guardian collaborates with in the child session. Omit for a
   * handoff that needs no conversation.
   */
  agentName?: string;
  payload?: Record<string, unknown>;
  handback?: HandbackSpec;
  /**
   * Appended to the resolution prompt the resumed caller receives, so the
   * caller learns its exact next step. The literal token `<childSessionId>` is
   * substituted with the handoff's child session id by the host.
   */
  handbackHint?: string;
}

/** True only for Rome Core's default agent, in legacy or canonical form. */
export function isCoreMainAgentId(value: string): boolean {
  return value === "main" || value === "core:main";
}

/**
 * Place one of this app's web widgets onto the guardian's workspace (the
 * freegrid), WITHOUT parking the calling agent. Unlike {@link PendingInteraction}
 * — which suspends the turn and waits for the guardian to resolve a surface —
 * this is fire-and-forget: the widget is mounted as a side effect and the agent
 * is told it succeeded and keeps going on the same turn. Use it to surface a
 * read-only view the guardian can glance at (e.g. Workflow Studio's storyboard),
 * not to collect input.
 *
 * Only takes effect on a webchat turn (the placement rides the turn's event
 * stream to the browser). On a messaging channel or inside a subagent there is
 * no workspace, so the calling agent is told the widget could not be shown.
 */
export interface PlaceWidget {
  appId: string;
  /**
   * Optional route within the app, e.g. `"orders/123"`. It rides the widget src
   * as the path after the app id (`/full/apps/<appId>/orders/123`), which the
   * host forwards to the app as `bootstrap.routePath` so the app's own router
   * resolves it. An unknown route is the app's to handle (typically a not-found
   * screen). This is *addressing*, not data: payloads belong in the app's own
   * session storage, which the route reads on mount (keyed by the chat session +
   * `params`).
   */
  route?: string;
  /**
   * Optional flat scalar parameters carried as query params on the widget src
   * (`?orderId=123`). The app reads them off `window.location.search`. Values must
   * be primitives so they serialize into the persisted placement and survive
   * remount. The query is the app's own namespace — the chat session the widget
   * is bound to is delivered separately via the app-web-sdk global-params channel
   * (`getChatSessionId()`), never as a query key.
   */
  params?: Record<string, string | number | boolean>;
}

/**
 * The envelope every action returns, discriminated on `status`. This one type
 * crosses every invocation boundary — agent↔action tool results, app↔app
 * `runAction`, webhook invocation records — so the states are modeled as a union
 * rather than independent flags: a result is exactly one of completed (`ok`),
 * domain-rejected (`error`), suspended on approval, suspended on an inline
 * guardian input (`pending_interaction`), suspended on a handoff to another agent
 * (`handoff`), or completed-with-a-widget-placed (`place_widget`, which does NOT
 * suspend). Infrastructure failures (handler throw, serialization, worker crash)
 * are NOT `error` results — they surface as a thrown {@link ActionInvocationError}.
 * The `error` variant is for domain rejections the caller can act on ("routine
 * name already taken").
 */
export type ActionResult<T = unknown> =
  | { status: "ok"; data?: T }
  | { status: "error"; error: string }
  | { status: "pending_approval"; approval: PendingApproval }
  | { status: "pending_interaction"; interaction: PendingInteraction }
  | { status: "handoff"; handoff: Handoff }
  | { status: "place_widget"; placement: PlaceWidget };

/**
 * Build an {@link Action} from a Zod input schema. The schema is the single
 * source of truth: it generates the model-facing JSON Schema (`inputSchema`),
 * the runtime validator, and the static input type handed to `execute`.
 *
 * The args an action receives come from a model tool call and are not
 * validated anywhere upstream. `defineAction` validates them here at the
 * boundary and fails closed — never an unchecked cast into the handler. Both
 * entry points reject invalid args the same way: `execute` returns an error
 * `ActionResult`, and `preview` returns an "Invalid input" card. Neither
 * throws, so a malformed call surfaces the validation error instead of a
 * missing approval card.
 *
 * For inputs whose model-facing schema must diverge from the validated type
 * (hand-tuned conditional schemas, internal-only fields), build the `Action`
 * object directly rather than reaching for an override here.
 */
export function defineAction<S extends z.ZodType>(spec: {
  config: ActionConfig;
  schema: S;
  execute: (input: z.infer<S>, context: ActionExecutionContext) => Promise<ActionResult>;
  preview?: (input: z.infer<S>) => PreviewPayload;
}): Action {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(spec.schema) as Record<
    string,
    unknown
  >;

  const invalidInputMessage = (error: z.ZodError): string =>
    `Invalid input for ${spec.config.name}: ${z.prettifyError(error)}`;

  const previewFn = spec.preview;

  return {
    config: spec.config,
    inputSchema,
    execute: async (args, context) => {
      const parsed = spec.schema.safeParse(args);
      if (!parsed.success) {
        return { status: "error", error: invalidInputMessage(parsed.error) };
      }
      return spec.execute(parsed.data, context ?? NOOP_ACTION_EXECUTION_CONTEXT);
    },
    ...(previewFn && {
      preview: (args: Record<string, unknown>): PreviewPayload => {
        const parsed = spec.schema.safeParse(args);
        if (!parsed.success) {
          return {
            kind: "generic",
            title: "Invalid input",
            summary: invalidInputMessage(parsed.error),
          };
        }
        return previewFn(parsed.data);
      },
    }),
  };
}

const NOOP_ACTION_EXECUTION_CONTEXT: ActionExecutionContext = {
  emitActionEvent() {
    // Direct calls to action.execute() in tests and local helpers have no
    // invocation observer. The real ActionEngine always supplies a context.
  },
};

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface AgentTokenUsage {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentContextUsage {
  usedTokens: number;
  windowTokens?: number;
  remainingTokens?: number;
}

export interface AgentAccounting {
  provider: string;
  model: string;
  usage: AgentTokenUsage;
  context?: AgentContextUsage;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  durationMs?: number;
  rawUsage?: Record<string, unknown>;
}

export type LifecycleEventVersion = 1;

export interface LifecycleThreadContext {
  channel: string;
  threadId: string;
  threadPath?: string;
  channelUserId?: string;
  threadName?: string;
  threadType?: "private" | "group";
  projectName?: string;
  projectPath?: string;
}

export interface AgentTurnRef {
  sessionId: string;
  turnId: string;
  agentName: string;
  channelThreadKey?: string;
  threadContext?: LifecycleThreadContext;
  parent?: {
    sessionId: string;
    turnId: string;
    agentName: string;
  };
}

export type AgentTurnStatus = "completed" | "interrupted" | "stopped" | "error";

export interface AgentTurnTiming {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface AgentTurnMetrics {
  toolCallCount: number;
  skillWritten: boolean;
}

export interface AgentTurnOutput {
  text: string;
  structuredOutput?: unknown;
  state: "final" | "partial" | "none";
  terminalKind?: "result" | "error";
  stopReason?: string;
  error?: string;
  accounting?: AgentAccounting;
}

export interface AgentTurnStartedEvent {
  type: "agent-turn-started";
  version: LifecycleEventVersion;
  turn: AgentTurnRef;
  timing: Pick<AgentTurnTiming, "startedAt">;
  input: {
    promptLength: number;
    attachmentsCount?: number;
  };
}

export interface AgentTurnStartedHook {
  onAgentTurnStarted(event: AgentTurnStartedEvent): Promise<void> | void;
}

export interface AgentTurnFinishedEvent {
  type: "agent-turn-finished";
  version: LifecycleEventVersion;
  turn: AgentTurnRef;
  status: AgentTurnStatus;
  timing: Required<AgentTurnTiming>;
  output: AgentTurnOutput;
  metrics: AgentTurnMetrics;
}

export interface AgentTurnFinishedHook {
  onAgentTurnFinished(event: AgentTurnFinishedEvent): Promise<void> | void;
}

export type AppLogger = Logger;

export interface AgentLifecycleHookDeps {
  appId: string;
  logger: AppLogger;
  appContext?: RomeAppContext;
  agentRunner?: AgentRunnerInterface;
}

// Awaited onion middleware around an agent turn. Agent model: docs/concepts/agents.md.

/** Identifies the wrapped turn; middleware matching uses only `agentName`. */
export interface TurnMiddlewareSession {
  /** AgentSession id (stable across turns of a conversation). */
  id: string;
  agentName: string;
  channelThreadKey: string;
}

/** Provider-agnostic reasoning effort used by agent and turn configuration. */
export const REASONING_EFFORT_VALUES = ["low", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];
export const DEFAULT_REASONING_EFFORT = "high" satisfies ReasoningEffort;

/** Mutable turn input. A middleware may rewrite `prompt` before `next()` to
 *  inject context or redact; the terminal model layer reads the rewritten
 *  value. */
export interface TurnMiddlewareInput {
  prompt: string;
  reasoningEffort?: ReasoningEffort;
}

export interface TurnMiddlewareContext {
  input: TurnMiddlewareInput;
  session: TurnMiddlewareSession;
  /** Emits model-shaped content. A terminal `result` produces the persisted assistant row. */
  emit(event: AgentMessage): void;
  /** Reserved for the self-loop guard when a future middleware re-injects a
   *  turn (e.g. replay). `welcome-to-rome` does not inject. */
  meta: { synthetic?: boolean };
}

/** Continue the onion: rewrite-then-continue and post-process both call this;
 *  a short-circuiting middleware simply never does. */
export type TurnMiddlewareNext = () => Promise<void>;

export interface TurnMiddlewareHook {
  /** Lowest order runs furthest out; the model layer is always innermost. */
  order: number;
  /** How the chain treats a throw from this middleware. `fail-open` (default)
   *  skips it and continues to `next()` so ordinary chat is never broken;
   *  `fail-closed` aborts the turn with an error block. */
  onError?: "fail-open" | "fail-closed";
  handle(ctx: TurnMiddlewareContext, next: TurnMiddlewareNext): Promise<void>;
}

export interface TurnMiddlewareHookDeps {
  appId: string;
  logger: AppLogger;
  appContext?: RomeAppContext;
  agentRunner?: AgentRunnerInterface;
}

// Agent event stream contracts. Session model: docs/concepts/sessions.md.

/** First event of a turn stream. Each stream contains exactly one. */
export interface TurnStartMessage {
  type: "turn_start";
  turnId: string;
  /** Session the turn runs on — stable across turns of a conversation. */
  sessionId: string;
  userPrompt: string;
}

/** Turn bracketing: the last event of a turn's stream, emitted after the
 *  terminal `result`/`error` block. */
export interface TurnEndMessage {
  type: "turn_end";
  turnId: string;
  /** Turn outcome. `interrupted` means the user stopped the turn mid-flight;
   *  it takes precedence over `error` (an abort surfaced as an error block is
   *  still an interruption, not a failure). */
  status: "completed" | "interrupted" | "error";
  /** Turn wall-clock measured by the AgentSession. Distinct from
   *  `accounting.durationMs` on the terminal block, which is the
   *  provider's self-reported per-call duration. */
  durationMs: number;
}

export interface TextMessage {
  type: "text";
  content: string;
  /** Provider-agnostic role of this text within its turn. `commentary` =
   *  in-turn narration emitted between/before tool calls; `final` = the turn's
   *  closing answer (also carried by the terminal `result` block). Sourced from
   *  the provider's native terminal signal (Anthropic `stop_reason`; Codex
   *  app-server `phase`). Optional: absence degrades to "unknown" (the text is
   *  not promoted into the answer flow). Borrows Codex's vocabulary by design;
   *  it is not Codex-specific. */
  turnPhase?: "commentary" | "final";
}

/**
 * Incremental preview of an in-flight `text` block (provider streaming).
 * Transient: the complete `text` block still follows, so consumers that
 * only care about whole blocks (trace, persistence, accounting) must
 * ignore this variant. Emitted only by providers that support partial
 * output; absence degrades to whole-block delivery.
 */
export interface TextDeltaMessage {
  type: "text_delta";
  content: string;
}

export interface ThinkingMessage {
  type: "thinking";
  content: string;
}

export interface ToolUseMessage {
  type: "tool_use";
  id: string;
  tool: string;
  input: unknown;
  startedAt?: string;
}

export interface ToolResultMessage {
  type: "tool_result";
  toolUseId: string;
  tool: string;
  output: unknown;
  endedAt?: string;
}

export interface SubagentStartMessage {
  type: "subagent_start";
  toolUseId: string;
  agentName: string;
  input: unknown;
  sessionId: string;
  turnId: string;
  startedAt?: string;
}

export type SubagentResultMessage =
  | {
      type: "subagent_result";
      toolUseId: string;
      agentName: string;
      sessionId: string;
      turnId: string;
      status: "completed";
      output: unknown;
      endedAt?: string;
    }
  | {
      type: "subagent_result";
      toolUseId: string;
      agentName: string;
      sessionId: string;
      turnId: string;
      status: "failed" | "cancelled";
      error: { message: string; code?: string };
      endedAt?: string;
    };

/** Terminal content block: the agent's final answer for its turn.
 *  The turn boundary itself is the `turn_end` event that follows. */
export interface ResultMessage {
  type: "result";
  content: string;
  /** Provider-native structured result when the agent declares outputSchema.
   * `content` is the canonical JSON serialization of this value. */
  structuredOutput?: unknown;
  /** Provider-reported usage for the agent that produced this block.
   *  Sub-agent terminals carry their own accounting. */
  accounting?: AgentAccounting;
}

/** Terminal content block: the turn failed. `turn_end` still follows. */
export type AgentErrorCode =
  | "usage_limit"
  | "auth_revoked"
  | "model_provider_unavailable"
  | "model_unavailable"
  | "no_model_provider_available";

export type AgentErrorProvider = "openai" | "anthropic";

export type AgentErrorReason =
  | "not_logged_in"
  | "quota_exhausted"
  | "model_access_denied"
  | "no_available_provider";

export interface ErrorMessage {
  type: "error";
  error: string;
  accounting?: AgentAccounting;
  /**
   * Optional machine-readable classification of the failure, set by providers
   * that can categorize it. `"usage_limit"` marks a provider whose quota/rate
   * limit is exhausted; `"auth_revoked"` marks a provider whose stored
   * credentials are no longer valid server-side (e.g. Codex's refresh token was
   * revoked) and need a re-login. Consumers use these instead of parsing the
   * human-readable `error`.
   */
  code?: AgentErrorCode;
  /** Provider and cause used by interactive clients to offer recovery UI. */
  provider?: AgentErrorProvider;
  reason?: AgentErrorReason;
}

export interface SessionInitMessage {
  type: "session_init";
  sessionId: string;
  /** Durable Rome trace for the current invocation. Treat as opaque. */
  romeSession?: RomeSessionRef;
  systemPrompt?: string;
  userPrompt?: string;
  projectPath?: string;
  /** Compatibility field; consumers must read turn identity from `turn_start`. */
  turnId?: string;
}

/**
 * Schema-validated structured output. Unlike the corresponding raw tool use,
 * this payload has been accepted and is authoritative.
 */
export interface StructuredOutputMessage {
  type: "structured_output";
  payload: unknown;
}

/** Provider-authored execution plan state; Rome persists and renders it unchanged. */
export type AgentPlanStepStatus = "pending" | "in_progress" | "completed";

export interface AgentPlanStep {
  /** Present for provider APIs that assign stable task IDs. */
  id?: string;
  /** Concise, stable description of the step. */
  text: string;
  /** Provider wording for the activity while this step is in progress. */
  activeText?: string;
  status: AgentPlanStepStatus;
}

export interface AgentPlan {
  /** Optional provider explanation for the latest Plan change. */
  explanation?: string;
  steps: AgentPlanStep[];
}

/** Complete replacement snapshot of the current provider-authored Plan. */
export interface PlanUpdateMessage {
  type: "plan_update";
  plan: AgentPlan;
}

export type AgentInputState =
  | "queued"
  | "submitted"
  | "accepted"
  | "consumed"
  | "unknown"
  | "cancelled"
  | "failed";

export interface InputStatusMessage {
  type: "input_status";
  inputId: string;
  state: AgentInputState;
  turnId?: string;
}

export type AgentMessage =
  | InputStatusMessage
  | TurnStartMessage
  | TurnEndMessage
  | TextMessage
  | TextDeltaMessage
  | ThinkingMessage
  | ToolUseMessage
  | ToolResultMessage
  | SubagentStartMessage
  | SubagentResultMessage
  | ResultMessage
  | ErrorMessage
  | SessionInitMessage
  | StructuredOutputMessage
  | PlanUpdateMessage;

export type StreamAgentMessage = AgentMessage & { agent?: string };

export interface ThreadContext {
  channel: string;
  /** Connection ledger identity that owns this provider conversation. */
  connectionId?: string;
  threadId: string;
  /** Parent chat id when threadId identifies a platform-native thread. */
  parentThreadId?: string;
  /** Stable Rome conversation resolved before the provider session is acquired. */
  romeSessionId?: string;
  threadPath?: string;
  channelUserId?: string;
  threadName?: string;
  threadType?: "private" | "group";
  projectName?: string;
  projectPath?: string;
  /**
   * Bond level of the message sender, when known. Lets turn-level logic tell the
   * guardian apart from other trusted senders (inner-circle, acquaintance) who
   * reach the same `<channel>:<thread>` trusted path.
   */
  senderBondLevel?: string;
}

export interface RunParams {
  agentName: string;
  prompt: string;
  /**
   * Absolute local paths of images to attach to the turn input. Providers
   * with image-input support (Codex) attach them to the user turn; providers
   * without it ignore them.
   */
  images?: string[];
  channelThreadKey?: string;
  threadContext?: ThreadContext;
  /** Stable Rome conversation to bind to the provider/runtime session. */
  romeSessionId?: string;
  /** Platform id of the inbound message that triggers this turn. */
  platformMessageId?: string;
  /** Platform message referenced by the current ordinary reply. */
  replyTo?: MessageReplyReference;
  sessionId?: string;
  contextSuffix?: string;
  sharedContext?: Record<string, unknown>;
  workingDir?: string;
}

/**
 * How a forked run's session is configured relative to its source.
 *
 * - `"isolated"` (default) — the fork opens with an empty tool surface: no
 *   actions, skills, subagents, or builtin tools, and no interactive-surface
 *   tools. The fork can only read the inherited conversation and answer.
 *   Right for side-channel turns that must not act (e.g. recap summaries).
 * - `"exact"` — a direct fork: the session opens with the source session's
 *   exact configuration (system prompt, action/skill catalogs, builtin and
 *   subagent tools, MCP servers, output contract), so the model-visible
 *   prefix is identical to the source conversation. Tools remain callable;
 *   executions are attributed to the fork's own session and turn ids.
 */
export type ForkRunMode = "isolated" | "exact";

/** Provider-native history anchor for the source turn of a fork. */
export interface ForkSourceCheckpoint {
  providerId: string;
  providerThreadId: string;
  checkpointId: string;
}

export interface ForkRunParams {
  agentName: string;
  sourceSessionId: string;
  prompt: string;
  /** Optional provider-agnostic capability tier override for the forked turn. */
  tier?: "large" | "medium" | "small";
  channelThreadKey: string;
  threadContext?: ThreadContext;
  workingDir?: string;
  /**
   * Turn on the source session that triggered this fork. Recorded as lineage
   * on the fork's rome session so the trajectory links back to the exact turn.
   */
  parentTurnId?: string;
  /**
   * Provider-native checkpoint for `parentTurnId`. When present, the fork
   * must end its inherited transcript at this checkpoint rather than at the
   * source session's current head.
   */
  sourceCheckpoint?: ForkSourceCheckpoint;
  /**
   * Short name for the fork's purpose (e.g. "recap"). Recorded as the fork
   * session's trigger name and used in its display name.
   */
  label?: string;
  /** Tool-surface mode for the fork. Defaults to `"isolated"`. */
  mode?: ForkRunMode;
}

export interface AgentRunnerInterface {
  run(params: RunParams): AsyncIterable<AgentMessage>;
  runForked?(params: ForkRunParams): AsyncIterable<AgentMessage>;
  /**
   * Returns true when the agent with the given name is loaded in the catalog
   * and can be invoked via `run`. Used by callers (e.g. the inbox message
   * handler) to fall back gracefully when a channel is configured to route to
   * an agent that has been uninstalled. Optional for backwards compatibility;
   * implementations that don't provide it are treated as always-true by
   * callers. May be async — the worker-side runner resolves the catalog over
   * RPC, so callers must `await` the result.
   */
  hasAgent?(name: string): boolean | Promise<boolean>;
  /**
   * Returns true when the named agent is allowed to call the named action —
   * i.e. the action resolves through the agent's allow-list (or `*`, or a
   * globally-granted action), the same resolution the agent session uses to
   * gate tool calls. Lets callers (e.g. the inbox message handler) tailor
   * guidance to what the routed agent can actually do, instead of assuming.
   * Optional for backwards compatibility; implementations that don't provide
   * it are treated as "cannot" by callers. May be async — the worker-side
   * runner resolves the catalog over RPC, so callers must `await` the result.
   */
  hasAction?(agentName: string, actionName: string): boolean | Promise<boolean>;
}

export interface ImageGenerationRequest {
  /** The image prompt, forwarded to the provider verbatim. */
  prompt: string;
  /**
   * Absolute local paths of input images for the provider to edit or combine
   * as the prompt describes (e.g. merge two photos, restyle a screenshot).
   * Callers validate existence; providers enforce their own format/size
   * limits and fail the generation rather than silently dropping an input.
   */
  inputImagePaths?: string[];
}

/** Ambient context threaded from the calling action into the provider run. */
export interface ImageGenerationContext {
  sharedContext?: Record<string, unknown>;
}

/**
 * One generated image, as the provider produced it. Exactly one of `data` /
 * `sourcePath` is set; persistence (where the file lives, how it is served)
 * is the caller's concern, not the provider's.
 */
export interface GeneratedImage {
  /** Base64-encoded image bytes. */
  data?: string;
  /** Absolute path of a file the provider already saved the image to. */
  sourcePath?: string;
  mimeType?: string;
  /** The prompt the image model actually used, when it revised the input. */
  revisedPrompt?: string;
}

export interface ImageGenerationProviderInfo {
  id: string;
  displayName: string;
}

/**
 * Advisory availability, used for provider selection and for composing
 * actionable "connect X" guidance. Providers must still fail closed in
 * `generate` — availability is a hint, never the gate.
 */
export type ImageProviderAvailability =
  | { available: true }
  | { available: false; reason: string; remedy: string };

export type ImageProviderGenerateResult =
  /** The provider produced an image. */
  | { status: "ok"; image: GeneratedImage }
  /** The provider's backing service is disconnected/out of quota — another provider may serve the request. */
  | { status: "unavailable"; reason: string; remedy: string }
  /** The provider ran but produced no image (refusal, content policy, empty output). */
  | { status: "failed"; message: string };

/** SPI implemented by each image generation backend. */
export interface ImageGenerationProvider extends ImageGenerationProviderInfo {
  availability(): Promise<ImageProviderAvailability>;
  generate(
    request: ImageGenerationRequest,
    ctx?: ImageGenerationContext,
  ): Promise<ImageProviderGenerateResult>;
}

export type ImageGenerationOutcome =
  | { status: "ok"; providerId: string; image: GeneratedImage }
  /** No provider could serve the request; one entry per registered provider with its remedy. */
  | {
      status: "unavailable";
      providers: Array<ImageGenerationProviderInfo & { reason: string; remedy: string }>;
    }
  | { status: "failed"; providerId: string; message: string };

/** What actions consume — provider registration, selection, and failover live behind it. */
export interface ImageGenerationInterface {
  listProviders(): ImageGenerationProviderInfo[];
  generate(
    request: ImageGenerationRequest,
    ctx?: ImageGenerationContext,
  ): Promise<ImageGenerationOutcome>;
}

export interface Attachment {
  type: "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact";
  url?: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  data?: Buffer;
  /** Absolute local path after an inbound channel attachment has been saved. */
  localPath?: string;
}

export interface OutgoingAttachment {
  type: "image" | "video" | "audio" | "document";
  source: string;
  caption?: string;
}

/**
 * Fields shared by every outbound message regardless of channel. The
 * channel-specific shape is a discriminated union over these (see
 * {@link OutgoingMessage}).
 */
export interface OutgoingMessageBase {
  text?: string;
  attachments?: OutgoingAttachment[];
  /** Optional id of the message being replied to (a chat threading hint;
   *  email threading uses {@link OutgoingEmailMessage.inReplyToMessageId}). */
  replyToMessageId?: string;
  /**
   * Structured message parts. When provided, replaces the plain-text path so
   * channels that support rich content (web chat today) can render typed
   * blocks like approval cards. Channels without rich support ignore it.
   */
  parts?: MessagePart[];
  /**
   * Opaque correlation id for the agent turn that produced this outbound
   * message. Channels are free to interpret it: web chat persists it on the
   * stored row so concurrent turns can be grouped on read; other channels
   * may use it for tracing/correlation or simply ignore it.
   */
  turnId?: string;
}

export interface ChannelSendResult {
  /** Provider-native id for the first delivered message, when available. */
  messageId?: string;
  /** Provider-native thread id when delivery creates or resolves one. */
  threadId?: string;
}

/**
 * Default branch: chat-style channels (telegram/whatsapp/wechat/discord/web
 * chat …). Carries no email-specific fields. The `kind` discriminant is
 * optional — an absent kind is treated as chat, so existing adapters and
 * callers need no change.
 */
export interface OutgoingChatMessage extends OutgoingMessageBase {
  kind?: "chat";
}

/**
 * Email branch. The recipient/subject/cc/bcc/html fields live only
 * here, so the email shape never leaks onto the chat contract — only the
 * EmailAdapter ever narrows to this branch.
 */
export interface OutgoingEmailMessage extends OutgoingMessageBase {
  kind: "email";
  /** Recipient(s). The literal `"guardian"` is resolved to the guardian's
   *  address by the EmailAdapter. Omit to reply on the inbound thread. */
  to?: string | string[];
  cc?: string[];
  bcc?: string[];
  /** Subject for a new email. Ignored for on-thread replies (kept by the provider). */
  subject?: string;
  /** Raw HTML body (e.g. an app-generated report). Sanitized before send; the
   *  text/plain alternative is derived from it. Wins over `text` when present. */
  html?: string;
  /** Provider message id to reply to, keeping the message on its thread. */
  inReplyToMessageId?: string;
}

/**
 * A `kind`-discriminated outbound message. Chat is the default branch; the
 * email branch carries the email-only fields. `Talk.send` receives this union;
 * non-email integrations read only the shared base fields.
 */
export type OutgoingMessage = OutgoingChatMessage | OutgoingEmailMessage;

export type ApprovalCardStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed";

export type MessagePart =
  | {
      type: "text";
      content: string;
      /** Role of this text within the agent turn that produced the message.
       *  `commentary` = in-turn narration the model emitted between/before tool
       *  calls; `final` = the turn's closing answer. Lets the conversation
       *  render in-turn narration (muted) inline before the answer without
       *  deriving it from the trace. Sourced from the provider's native marker
       *  (Anthropic `stop_reason`; Codex app-server `phase`). Absent on legacy
       *  rows (and channels that don't split turns) → treated as `final`. */
      turnPhase?: "commentary" | "final";
      /** Zero-based identity of this WebChat assistant text block within its turn.
       *  Assigned by the WebChat projection and persisted so the live SSE
       *  block and transcript block share the same `(turnId, blockIx)` key.
       *  Absent on legacy rows and channels that do not stream text blocks. */
      blockIx?: number;
    }
  | {
      type: "turn_recap";
      turnId: string;
      content: string;
      audioUrl?: string;
      audioMimeType?: string;
      audioDurationMs?: number;
    }
  | {
      type: "approval_card";
      approvalId: string;
      actionName: string;
      preview: PreviewPayload;
      status: ApprovalCardStatus;
    }
  | {
      /**
       * An interactive "routine draft" the agent proposes mid-conversation.
       * The web chat renders a confirm card; turning it on creates the routine
       * via POST /api/routines. The part carries both the human-readable
       * summary (sentence + when/then) and the machine spec needed to create
       * the routine, so confirmation is a pure client-side create with no
       * second agent turn.
       */
      type: "routine_draft_card";
      toolUseId: string;
      draft: RoutineDraftSpec;
    }
  | {
      /**
       * A parked inline guardian input the agent is waiting on. The action that
       * called for it returned a `pending_interaction` result; the webchat drain
       * loop snapshots this part keyed by the tool call's id, and the host
       * mounts the app's component in the transcript. The component lives in
       * the app, not core.
       */
      type: "pending_interaction";
      toolUseId: string;
      appId: string;
      render: {
        kind: "inline";
        componentId: string;
        props?: Record<string, unknown>;
        /** Host built-in component (e.g. the ask_question card): rendered by
         *  rome-web directly, with no owning app to validate. */
        builtin?: boolean;
      };
    }
  | {
      /**
       * A handoff in progress: the calling agent suspended and `agentName`
       * holds the floor in `childSessionId` (the spawned design conversation).
       * The summoned agent brings up its own surface on the child session, so
       * the card carries no `surface` of its own. The webchat drain loop
       * snapshots this part keyed by the tool call's id.
       */
      type: "handoff";
      toolUseId: string;
      appId: string;
      agentName?: string;
      payload?: Record<string, unknown>;
      childSessionId?: string;
      /** Mirrors {@link Handoff.handbackHint}; appended to the resolution
       * prompt when the handoff resolves with an artifact. */
      handbackHint?: string;
    }
  | {
      /**
       * A schema-valid payload the specialist agent submitted via
       * `submit_output` in a handoff child session that carries a handback
       * contract. The host renders it as an approval card: Approve ends the
       * handoff with `payload` as the output; "keep editing" feedback continues
       * the conversation and a later submission supersedes this card.
       */
      type: "submission_card";
      payload: Record<string, unknown>;
    }
  | {
      /**
       * Resolution of an inline interaction or a handoff — the single
       * resolution part both suspension kinds share. Lives in a user-role
       * webchat message so the UI derives "this resolved" by scanning for a
       * matching toolUseId, and the server re-drives the calling agent with a
       * server-built outcome prompt. `output` is the produced artifact (a
       * handoff's approved handback payload, or an inline component's result),
       * or `{ dismissed: true }`.
       */
      type: "interaction_result";
      toolUseId: string;
      output: Record<string, unknown>;
    };

/** The proposed routine, as snapshotted from the agent's `propose_routine`
 * tool call. `name`/`trigger`/`actionName`/`args` are the create payload;
 * the rest are display strings the card renders. The routine fires either when
 * a matching event arrives (event-bus trigger) or on a schedule. */
export interface RoutineDraftSpec {
  /** One-line headline, e.g. "When you get an email from Dana, Rome will text you." */
  sentence: string;
  /** Stored routine name. */
  name: string;
  /** What triggers it, in human terms: "Gmail · new email" or "Every Friday at 9:00 AM". */
  watchLabel: string;
  /** Plain narrowing summary for event triggers, e.g. "sender is dana@example.com".
   * Omit for watch-all and for schedule triggers. */
  filterSummary?: string;
  /** What Rome does, e.g. "summarize it and text you on Telegram". */
  thenSummary: string;
  /** The trigger the routine is created with — an event-bus match, a schedule,
   * or `manual` (no automatic firing; run by hand from the Routines page). */
  trigger: ScheduleTrigger | EventBusTrigger | ManualTrigger;
  /** Action the routine fires. */
  actionName: string;
  /** Single argument object for the action. */
  args: Record<string, unknown>;
  /** Ground-truth render of the bound `actionName(args)` call, produced by the
   * action's own {@link Action.preview}. Authoritative — unlike the prose
   * summaries above (agent-authored, drift-prone), this comes from the action
   * itself, so the card shows what will actually fire. Absent when the bound
   * action implements no `preview()`; the card then falls back to the prose. */
  preview?: PreviewPayload;
}

/**
 * Optional per-message routing overrides resolved by the channel adapter from
 * its channel-level configuration. When present, the downstream message handler
 * uses these to override the default trusted-path target agent. Untrusted
 * messages still go through sentinel regardless.
 */
export interface MessageRouting {
  /**
   * Name of the agent to route this message to on the trusted path. Falls back
   * to the default ("main") when undefined or when the named agent is not
   * present in the catalog.
   */
  agentName?: string;
}

/** Provider-normalized reference attached to an ordinary inbound reply. */
export interface MessageReplyReference {
  /** Provider/server id of the referenced message. */
  messageId: string;
  /** Exact referenced-message text supplied by the provider event, when available. */
  content?: string;
  /** Display name supplied with the referenced-message event snapshot. */
  senderName?: string;
}

export interface NormalizedMessage {
  id: string;
  channel:
    | "telegram"
    | "telegram_user"
    | "whatsapp"
    | "wechat"
    | "webchat"
    | "discord"
    | "email"
    | "feishu"
    | "linkedin";
  channelUserId: string;
  displayName: string;
  threadId: string;
  /** Parent chat id when threadId is a platform-native thread id. */
  parentThreadId?: string;
  threadName?: string;
  threadType: "private" | "group";
  timestamp: Date;
  text: string;
  attachments: Attachment[];
  replyTo?: MessageReplyReference;
  routing?: MessageRouting;
  rawEvent: unknown;
}

/** Opaque provider-owned conversation address. Callers may persist and
 * round-trip this value, but must never parse or construct one. */
export type ConversationId = string & { readonly __brand: "ConversationId" };

export interface ConversationRef {
  connectionId: string;
  conversationId: ConversationId;
}

export interface ConversationDescriptor {
  ref: ConversationRef;
  service: string;
  kind: "dm" | "group" | "channel" | "topic";
  displayName: string;
  parent?: ConversationRef;
  containerName?: string;
}

/** Provider-neutral message delivered by Talk. Provider-native data is an
 * opaque pass-through token reserved for a feature on the same provider. */
export interface InboundMessage {
  messageId: string;
  conversationId: ConversationId;
  /** Parent conversation when this message belongs to a native thread. */
  parentConversationId?: ConversationId;
  senderId: string;
  senderDisplayName?: string;
  text: string;
  attachments: Attachment[];
  timestamp: Date;
  replyTo?: MessageReplyReference;
  thread?: { kind: "dm" | "group" | "topic"; name?: string };
  raw?: unknown;
}

export interface MessageReceipt {
  messageId?: string;
  conversationId: ConversationId;
  parts?: Array<{ messageId: string; kind: string }>;
}

export interface TalkHistory {
  query(input: {
    conversationId?: ConversationId;
    since?: Date;
    limit?: number;
  }): Promise<InboundMessage[]>;
}

export interface TalkInboundMedia {
  materialize(message: InboundMessage): Promise<Attachment[]>;
}

export interface TalkActivitySession {
  update(state: "thinking" | "working"): Promise<void>;
  finish(result: "done" | "error"): Promise<void>;
}

export interface TalkActivity {
  begin(input: {
    conversationId: ConversationId;
    messageId?: string;
  }): Promise<TalkActivitySession | null>;
}

export interface TalkDirectory {
  listConversations(input: {
    query?: string;
    cursor?: string;
    limit: number;
    includeTopics?: boolean;
  }): Promise<{ conversations: ConversationDescriptor[]; nextCursor?: string }>;
}

export interface ConversationInteraction {
  id: string;
  conversationId: ConversationId;
  actorId: string;
  value: unknown;
}

export interface ConversationPresentation {
  textFallback: string;
  parts?: MessagePart[];
}

export interface TalkInteractions {
  subscribe(handler: (event: ConversationInteraction) => Promise<void>): () => void;
  update(input: {
    messageId: string;
    conversationId: ConversationId;
    presentation: ConversationPresentation;
  }): Promise<void>;
}

export interface TalkFeatureMap {
  history: TalkHistory;
  inboundMedia: TalkInboundMedia;
  activity: TalkActivity;
  directory: TalkDirectory;
  interactions: TalkInteractions;
}

export type TalkFeatureName = keyof TalkFeatureMap;

export interface Talk {
  subscribe(handler: (message: InboundMessage) => Promise<void>): () => void;
  send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt>;
  feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null;
}

/** Stable provider-neutral routing surface exposed to Core consumers and Apps. */
export interface TalkRouter {
  list(): Promise<Array<{ connectionId: string; service: string }>>;
  subscribe(connectionId: string, handler: (message: InboundMessage) => Promise<void>): () => void;
  send(
    connectionId: string,
    conversationId: ConversationId,
    message: OutgoingMessage,
  ): Promise<MessageReceipt>;
  feature<K extends TalkFeatureName>(connectionId: string, name: K): TalkFeatureMap[K] | null;
}

export interface ChannelMessageHook {
  register(): Promise<void>;
  registerConnection(connectionId: string, service: string): void;
  /** Detach every subscription `register`/`registerConnection` took out, so
   * the host can swap in a replacement instance (e.g. after an app-keys
   * environment change) without double-handling inbound messages. A hook
   * without this method cannot be hot-swapped and stays live until restart. */
  unregister?(): void;
}

export interface ActionRunContext {
  initiator?: string;
  channelContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  executionId?: string;
  rootExecutionId?: string;
  parentExecutionId?: string;
  parentActionName?: string;
  actionName?: string;
}

export interface CurrentActionContext {
  actionName?: string;
  executionId?: string;
  rootExecutionId?: string;
  parentExecutionId?: string;
  parentActionName?: string;
  /** The app that directly invoked this action through its app-context
   * `runAction`. Set by the runtime from action ownership (not app-supplied),
   * carried per-hop (not inherited from the chain). Lets an action attribute
   * work to the calling app — e.g. create_routine stamps `managedBy`. Undefined
   * for agent / user / system-initiated calls. */
  callerAppId?: string;
  channelContext?: ThreadContext;
  sessionId?: string;
  turnId?: string;
  agentName?: string;
  channelThreadKey?: string;
  sharedContext?: Record<string, unknown>;
}

const CURRENT_ACTION_CONTEXT_RESOLVER = Symbol.for("rome.appRuntime.currentActionContextResolver");
const CURRENT_ACTION_CONTEXT_RUNNER = Symbol.for("rome.appRuntime.currentActionContextRunner");

export type CurrentActionContextPatch = Partial<CurrentActionContext>;

type CurrentActionContextRunner = <T>(
  patch: CurrentActionContextPatch,
  fn: () => Promise<T>,
) => Promise<T>;

type GlobalActionContextRegistry = typeof globalThis & {
  [CURRENT_ACTION_CONTEXT_RESOLVER]?: (() => CurrentActionContext | undefined) | undefined;
  [CURRENT_ACTION_CONTEXT_RUNNER]?: CurrentActionContextRunner | undefined;
};

export function setCurrentActionContextResolver(
  resolver: (() => CurrentActionContext | undefined) | null,
): void {
  const registry = globalThis as GlobalActionContextRegistry;
  registry[CURRENT_ACTION_CONTEXT_RESOLVER] = resolver ?? undefined;
}

export function getCurrentActionContext(): CurrentActionContext | undefined {
  const registry = globalThis as GlobalActionContextRegistry;
  return registry[CURRENT_ACTION_CONTEXT_RESOLVER]?.();
}

export function setCurrentActionContextRunner(runner: CurrentActionContextRunner | null): void {
  const registry = globalThis as GlobalActionContextRegistry;
  registry[CURRENT_ACTION_CONTEXT_RUNNER] = runner ?? undefined;
}

export async function runWithCurrentActionContext<T>(
  patch: CurrentActionContextPatch,
  fn: () => Promise<T>,
): Promise<T> {
  const registry = globalThis as GlobalActionContextRegistry;
  const runner = registry[CURRENT_ACTION_CONTEXT_RUNNER];
  if (!runner) {
    return await fn();
  }

  return await runner(patch, fn);
}

export interface ActionEngineLike {
  run(
    name: string,
    args: Record<string, unknown>,
    context?: ActionRunContext,
  ): Promise<ActionResult>;
}

const LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LEVEL_ORDER;

export type DrizzleDb = BetterSQLite3Database<Record<string, never>>;

export interface AppDbContext {
  connection: DrizzleDb;
  tablePrefix: string;
  tableName(name: string): string;
}

export interface RomeAppDefinition {
  id: string;
  version: string;
  description: string;
  kind?: string;
}

export interface FavorRequiredActionDefinition {
  actionName: string;
  amount: number;
  title: string;
  summary?: string;
  argsSchema: Record<string, unknown>;
  displayFields: Array<{ label: string; from: string }>;
}

export interface FavorActionRequestView {
  id: string;
  payerUserId: string | null;
  requestorUserId: string;
  recipientUserId: string;
  requesterInstanceId: string | null;
  requesterAppId: string;
  requesterAppIdentity: Record<string, unknown>;
  actionName: string;
  definitionHash: string;
  actionRefHash: string;
  amount: number;
  displayPayload: Record<string, unknown>;
  attribution: Record<string, unknown>;
  taskRef: Record<string, unknown> | null;
  status: "pending" | "settled" | "declined" | "expired" | "failed";
  dispatchStatus: "blocked" | "queued" | "claimed" | "succeeded" | "action_failed";
  dispatchAttemptCount: number;
  dispatchClaimExpiresAt: string | null;
  idempotencyKey: string;
  failureReason: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  settledAt: string | null;
  queuedAt: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface AppFavorCapability {
  requestAction(input: {
    actionName: string;
    args: Record<string, unknown>;
    taskRef?: Record<string, unknown>;
    idempotencyKey: string;
    /**
     * The page the paying visitor should return to after approving or
     * declining the charge on Rome Cloud — typically the page that requested
     * the favor (e.g. `window.location.pathname + window.location.search`,
     * forwarded by the app's API handler). Must be an absolute path on the
     * instance origin, inside this app's `/apps/<appId>` prefix; anything
     * else falls back to the app root. When omitted, payers land on
     * `/apps/<appId>`. Rome Cloud appends `favor=settled` or
     * `favor=declined` to the return URL so the page can reflect the
     * outcome.
     */
    returnTo?: string;
  }): Promise<
    | { status: "queued"; request: FavorActionRequestView }
    | {
        status: "pending_consent";
        requestId: string;
        authorizationUrl?: string;
        request?: FavorActionRequestView;
      }
    | { status: "declined"; requestId: string; request?: FavorActionRequestView }
    | { status: "error"; error: string }
  >;
}

export interface AppRuntimeRepositories {
  settings: AppSettingsRepository;
  webchatRecaps?: WebChatRecapRepository;
  conversations?: ConversationRepository;
}

export interface AppSettingsRepository {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ConversationRecord {
  id: string;
  agentName: string | null;
}

export interface ConversationRepository {
  ensureChannelConversation(input: {
    channel: string;
    threadId: string;
    parentThreadId?: string;
    threadName?: string;
    threadType?: "private" | "group";
    agentName: string;
    projectName?: string;
    projectPath?: string;
  }): Promise<ConversationRecord>;
  addMessage(input: {
    sessionId: string;
    role: "user" | "notification";
    content: string;
    platformMessageId: string;
    senderId?: string;
    senderName?: string;
    replyToPlatformMessageId?: string;
    createdAt?: Date;
  }): Promise<{ inserted: boolean }>;
  promoteMessageToUser(sessionId: string, platformMessageId: string): Promise<void>;
  recordOutboundMessage(input: {
    sessionId: string;
    content: string;
    platformMessageId?: string;
    senderId?: string;
    senderName?: string;
    replyToPlatformMessageId?: string;
    turnId?: string;
    knownToProvider: boolean;
  }): Promise<void>;
}

export interface WebChatRecapSession {
  id: string;
  name: string;
  personaId: string | null;
  largeModelSelection: string | null;
  projectName: string;
  projectPath: string | null;
  agentName: string | null;
  createdAt: Date;
}

export interface WebChatRecapMessage {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: string;
  content: string;
  createdAt: Date;
}

export interface AddTurnRecapMessageInput {
  sessionId: string;
  turnId: string;
  content: string;
  audioUrl?: string;
  audioMimeType?: string;
  audioDurationMs?: number;
}

export interface WebChatRecapRepository {
  getSession(id: string): Promise<WebChatRecapSession | null>;
  getMessages(sessionId: string): Promise<WebChatRecapMessage[]>;
  addTurnRecapMessage(input: AddTurnRecapMessageInput): Promise<WebChatRecapMessage>;
}

// @ts-expect-error The public recap port must not expose broader WebChat repository methods.
type _WebChatRecapRepositoryDoesNotExposeDeleteSession = WebChatRecapRepository["deleteSession"];

export interface RomeAppContext {
  app: RomeAppDefinition;
  controller: unknown;
  db: AppDbContext;
  log: Logger;
  repositories: AppRuntimeRepositories;
  favors: AppFavorCapability;
  runAction(
    name: string,
    args: Record<string, unknown>,
    options?: RunActionOptions,
  ): Promise<ActionResult>;
  runAction(
    name: string,
    args: Record<string, unknown>,
    options: DetachedRunActionOptions,
  ): Promise<ActionDispatchReceipt>;
  invokeAction<TEvent extends ActionEvent = ActionEvent, TOutput = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): ActionInvocation<TEvent, TOutput>;
  listRoutines(): Promise<Routine[]>;
}

export type ActionInvocationErrorCode =
  | "not_found"
  | "unserializable"
  | "handler_error"
  | "worker_failure";

/**
 * The single failure shape of `RomeAppContext.runAction`. Every
 * invocation failure — unknown action, args/result that can't cross a process
 * boundary, a throwing handler, a dead worker — surfaces as this type with the
 * same fields regardless of which process the caller or callee ran in, so app
 * code never branches on transport. Cancellation is the one pass-through: it
 * is a control signal for the runtime, not a failure the app handles.
 */
export class ActionInvocationError extends Error {
  constructor(
    readonly actionName: string,
    readonly code: ActionInvocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ActionInvocationError";
  }
}

export type AppActionRuntimeDeps<TShared = Record<string, unknown>> = TShared & {
  appContext: RomeAppContext;
};

/**
 * Who is making this app-api request, resolved by the Rome host **before** the
 * request reaches your handler. This is the single trustworthy "who is
 * calling" answer — never derive identity from request headers yourself
 * (identity headers such as `X-Rome-User-Id` are stripped by the host, and on
 * a public app any surviving header is attacker-controlled).
 *
 * - `guardian` — the instance owner: a valid dashboard session (`via:
 *   "cookie"`) or a trusted in-container caller such as the agent or the
 *   agent browser (`via: "loopback"`). Gate owner-only routes on this:
 *   `if (request.caller.kind !== "guardian") return 401`.
 * - `visitor` — a verified Rome Cloud visitor (cloud-email access tier),
 *   resolved server-side from the visitor session. The session itself
 *   (including its favor token) stays host-side; `ctx.favors.requestAction`
 *   reads it from the request context automatically.
 * - `anonymous` — everyone else; on a public app this is any internet caller.
 *
 * A guardian who also holds a visitor session resolves as `guardian` (the
 * visitor session still feeds `ctx.favors` host-side).
 */
export type RomeAppCaller =
  | { kind: "guardian"; userId: string; via: "cookie" | "loopback" }
  | { kind: "visitor"; accountId: string; email: string }
  | { kind: "anonymous" };

export interface RomeAppApiRequest {
  method: string;
  path: string[];
  headers: Record<string, string>;
  query: URLSearchParams;
  body?: Uint8Array;
  /** Resolved caller identity — see {@link RomeAppCaller}. */
  caller: RomeAppCaller;
}

export interface RomeAppApiHandler {
  handle(request: RomeAppApiRequest): Promise<Response>;
}

/**
 * The standardized 401 body for "this route needs a signed-in Rome Cloud
 * visitor". A stable contract with app frontends: the web SDK's sign-in UI
 * (`CallerBadge` / `useVisitorSignIn` in `@rome-os/app-web-sdk`) and
 * hand-rolled clients alike match on `error === "visitor_auth_required"` to
 * show a sign-in hint instead of a generic failure — keep the shape
 * wire-stable.
 */
export interface VisitorAuthRequiredPayload {
  error: "visitor_auth_required";
  /** Human-readable hint, safe to surface directly in the UI. */
  message: string;
}

const VISITOR_AUTH_REQUIRED_MESSAGE = "Sign in with Rome Cloud to continue.";

/**
 * Build the standardized `401 visitor_auth_required` response. Exposed
 * separately from {@link requireVisitor} so handlers can reuse it on the
 * *late* failure path too: `ctx.favors.requestAction` returns
 * `{ status: "error", error: "visitor_auth_required" }` when the caller
 * resolved but holds no visitor session (e.g. the guardian), and surfacing
 * that through this same body keeps the frontend's 401 handling uniform.
 */
export function visitorAuthRequired(message: string = VISITOR_AUTH_REQUIRED_MESSAGE): Response {
  const payload: VisitorAuthRequiredPayload = { error: "visitor_auth_required", message };
  return Response.json(payload, { status: 401 });
}

/** Result of {@link requireVisitor} — a discriminated union so the deny branch
 *  is a one-liner: `if (!auth.ok) return auth.response;`. */
export type RequireVisitorResult =
  | { ok: true; caller: Exclude<RomeAppCaller, { kind: "anonymous" }> }
  | { ok: false; response: Response };

/**
 * Gate an app-api route on a signed-in caller, with the standardized 401 for
 * everyone else:
 *
 * ```ts
 * const auth = requireVisitor(request);
 * if (!auth.ok) return auth.response;
 * // auth.caller is guardian | visitor from here on
 * ```
 *
 * By default the guardian passes too (`allowGuardian: true`): favor-charged
 * routes still work for an owner who holds a visitor session — the host-side
 * session feeds `ctx.favors.requestAction`, and an owner *without* one gets
 * the `visitor_auth_required` error from `requestAction` itself (pipe that
 * through {@link visitorAuthRequired} for a uniform 401). Pass
 * `allowGuardian: false` for routes that only make sense for true visitors.
 *
 * This is enforcement — it reads the host-resolved `request.caller`, never
 * headers. The client-side counterpart (`useCaller()` in the web SDK) is
 * advisory UI gating only.
 */
export function requireVisitor(
  request: RomeAppApiRequest,
  opts?: { message?: string; allowGuardian?: boolean },
): RequireVisitorResult {
  // Hosts older than the request.caller contract don't stamp the field —
  // treat that as anonymous rather than crashing (same degradation the
  // web SDK applies).
  const caller: RomeAppCaller = request.caller ?? { kind: "anonymous" };
  const allowGuardian = opts?.allowGuardian ?? true;
  if (caller.kind === "visitor" || (caller.kind === "guardian" && allowGuardian)) {
    return { ok: true, caller };
  }
  return { ok: false, response: visitorAuthRequired(opts?.message) };
}

/**
 * A live WebSocket connection, as seen by app code. The host owns the
 * underlying socket and the upgrade handshake; this facade exposes only what an
 * app needs, with no access to the raw socket. One facade per
 * connection.
 */
export interface RomeAppWebSocket {
  /** Send a text (string) or binary (Uint8Array) frame. No-op once closed. */
  send(data: string | Uint8Array): void;
  /** Close the connection. `code` defaults to 1000 (normal closure). */
  close(code?: number, reason?: string): void;
  /** Standard WebSocket readyState (0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED). */
  readonly readyState: number;
}

/**
 * Per-connection callbacks. `open`/`message` receive the connection so they can
 * act on it; `close` does not — the connection is already terminal, so it only
 * reports `code`/`reason`. Identify which connection closed via the `ws`
 * captured in `open`'s closure.
 */
export interface RomeAppWebSocketHandlers {
  open?(ws: RomeAppWebSocket): void | Promise<void>;
  message?(ws: RomeAppWebSocket, data: string | Uint8Array): void | Promise<void>;
  close?(code: number, reason: string): void | Promise<void>;
  error?(err: Error): void;
}

/** @internal — host-injected bridge (global symbol so it crosses package boundaries). */
const WS_UPGRADE_ACCEPT = Symbol.for("rome-os.app-runtime.ws.accept");

/**
 * Accept a WebSocket upgrade from inside an app's `handle(request)`. Returns the
 * `Response` to return from the handler — for a genuine upgrade request the host
 * completes the handshake and starts dispatching to `handlers`; for any other
 * request it returns `426 Upgrade Required`, so a handler can call this
 * unconditionally on a route and let non-WS callers get a clean error.
 *
 * The host owns the socket: `handlers` callbacks run with a {@link RomeAppWebSocket}
 * facade, never a raw socket.
 */
export function upgradeWebSocket(
  request: RomeAppApiRequest,
  handlers: RomeAppWebSocketHandlers,
): Response {
  const accept = (request as { [WS_UPGRADE_ACCEPT]?: (h: RomeAppWebSocketHandlers) => Response })[
    WS_UPGRADE_ACCEPT
  ];
  if (typeof accept !== "function") {
    return new Response("Expected a WebSocket upgrade request", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }
  return accept(handlers);
}

/**
 * One account linked to a person.
 *
 * A channel mapping is a link and `channelUserId` is the account's own address
 * (docs/concepts/people.md). The names here are the published wire contract and
 * the database's, so they stay as they are.
 */
export interface ChannelMappingRecord {
  channel: string;
  channelUserId: string;
}

export interface PersonRecord {
  id: string;
  displayName: string;
  bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
  channelMappings: ChannelMappingRecord[];
  profilePath?: string | null;
  approved?: boolean | null;
  createdAt?: Date;
  [key: string]: unknown;
}

/** The people the host knows and the accounts linked to each. Named for the
 *  `channel_mappings` table it reads; see {@link ChannelMappingRecord}. */
export interface PersonMappingRepository {
  findByChannelUser(channel: string, channelUserId: string): Promise<PersonRecord | null>;
  findByName(displayName: string): Promise<PersonRecord[]>;
  findByNameFuzzy(displayName: string): Promise<PersonRecord | null>;
  findByBondLevel(
    bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other",
  ): Promise<PersonRecord[]>;
  create(data: {
    displayName: string;
    bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
    profilePath?: string;
    approved?: boolean;
    channelMappings?: { channel: string; channelUserId: string }[];
  }): Promise<string>;
  addChannelMapping(
    personId: string,
    channel: string,
    channelUserId: string,
    displayName?: string,
  ): Promise<unknown>;
}

/**
 * The approval lifecycles an app may create. Closed, because `type` selects how
 * the record is resolved rather than describing what it is about: the host
 * queues an execution only for `action_execution`, and only that kind offers a
 * retry. A value outside this set persists a record nothing downstream can
 * resolve, so the host rejects it at write time. Describe the subject in
 * `payload` and `description` instead.
 */
export const APPROVAL_TYPES = ["action_execution", "outgoing_message", "person_mapping"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "auto_approved"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalRecord {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedBy: string;
  description: string;
  payload: unknown;
  createdAt: Date;
}

export interface ApprovalsRepository {
  create(data: {
    type: ApprovalType;
    requestedBy: string;
    description: string;
    payload?: unknown;
    status?: ApprovalStatus;
  }): Promise<string>;
}

export interface SentinelLogEntry {
  id: string;
  channel: string;
  channelUserId: string;
  displayName: string | null;
  text: string | null;
  action: "replied" | "ignored" | "escalated";
  response: string | null;
  createdAt: Date;
}

export interface SentinelLogRepository {
  create(data: {
    messageId: string;
    channel: string;
    channelUserId: string;
    displayName?: string;
    threadId?: string;
    text?: string;
    action: "replied" | "ignored" | "escalated";
    response?: string;
  }): Promise<string>;
  findUnreviewed(): Promise<SentinelLogEntry[]>;
  markReviewed(ids: string[]): Promise<void>;
}

export type SettingsRepository = AppSettingsRepository;

export interface PolicyRule {
  action: "allow" | "block" | "require_approval" | "sentinel_review";
  conditions?: Record<string, unknown>;
}

export interface PolicyContext {
  channel: string;
  sender: { id: string; bondLevel: string } | null;
  bondLevel: string;
  threadName?: string;
  threadType?: string;
}

export interface PolicyEngine {
  evaluate(context: PolicyContext): Promise<PolicyRule>;
}

// Routine contracts. Action model: docs/concepts/actions.md.

export interface ScheduleTrigger {
  type: "schedule";
  tzid: string;
  localTime: string;
  /** Required timezone binding. `floating` follows the guardian's current zone;
   * binding explicitly. `floating` resolves `localTime` against the guardian's
   * current timezone, so the routine follows the guardian when they change it.
   * `fixed` is the "absolute zone" choice: it pins the schedule to the literal
   * `tzid`. */
  tzMode: "fixed" | "floating";
  /** Specific calendar date for a true one-off ("YYYY-MM-DD"). Mutually
   * exclusive with `rrule`. When neither is set, fires once at the next
   * matching `localTime`. */
  date?: string;
  rrule?: string;
}

export interface WebhookTrigger {
  type: "webhook";
  path: string;
  secret?: string;
}

/** One equality condition on an event's payload. `field` is a dot-path into the
 * payload object (e.g. "from.email"); the condition holds when the value at that
 * path, coerced with String(), equals `equals`. */
export interface EventFilterCondition {
  field: string;
  equals: string;
}

export interface EventBusTrigger {
  type: "event-bus";
  eventName: string;
  sourcePattern?: string;
  /** Payload conditions, AND-ed together. Absent or empty means fire on every
   * event of this name. */
  filter?: EventFilterCondition[];
}

/** A producer app's declaration that it can currently emit `eventType`.
 * `eventType` is the same value a routine binds to as
 * `EventBusTrigger.eventName`; `appId` is the producer that owns it. Surfaced to
 * apps discovering which events are watchable (e.g. `search_event_catalog`). */
export interface EventCatalogEntry {
  eventType: string;
  appId: string;
  /** JSON Schema for the event's payload — the same vocabulary action input
   * schemas use. With `schemaOrigin: "observed"` it is inferred from the most
   * recent non-empty emission, so it is a discovery aid for a consumer writing
   * a routine `trigger.filter` (whose dot-paths read payload fields), **not** a
   * contract: it reflects one observed payload, may omit optional keys, and
   * deliberately carries no `required` (one sample can't establish
   * requiredness). Absent until the type has been emitted with a non-empty
   * payload. */
  payloadSchema?: JSONSchema.ObjectSchema;
  /** Where `payloadSchema` came from. `"observed"` = inferred from a real
   * emission. `"declared"` is reserved for producer-authored schemas
   * (pre-registration); a declared schema is authoritative and is never
   * overwritten by an observed one. */
  schemaOrigin?: "observed" | "declared";
}

export interface PollTrigger {
  type: "poll";
  source: string;
  interval: string;
  query?: Record<string, unknown>;
}

/** A routine with no automatic firing condition — it runs only via the
 * out-of-band "run now" path (the dashboard's Run-now button /
 * `POST /routines/:id/run`). Carries no config of its own. */
export interface ManualTrigger {
  type: "manual";
}

export type Trigger =
  | ScheduleTrigger
  | WebhookTrigger
  | EventBusTrigger
  | PollTrigger
  | ManualTrigger;

export interface Routine {
  id: string;
  name: string;
  /** Optional caller-assigned unique identity, distinct from the human-readable
   * `name`. Used for dedup/idempotency. Unset on routines that don't opt in. */
  key?: string;
  /** The app that owns and manages this routine (its appId). A managed routine
   * can't be deleted by a user — only by the managing app. Unset for routines a
   * guardian or agent created directly. */
  managedBy?: string;
  enabled: boolean;
  trigger: Trigger;
  actionName: string;
  args: Record<string, unknown>;
  createdAt: Date;
  lastFiredAt?: Date;
  nextRunAt?: Date;
}

/** Outcome of {@link RoutinesRepository.deleteIfNoActiveRuns}. The active-run
 * check and the delete are one transaction, so this is authoritative — there
 * is no separate existence race to lose. */
export type DeleteRoutineResult =
  | { status: "deleted"; name: string }
  | { status: "active-runs"; activeRuns: number }
  /** The routine is managed by an app and the caller isn't that app. */
  | { status: "managed"; managedBy: string }
  | { status: "not-found" };

export interface RoutinesRepository {
  create(data: {
    name: string;
    /** Optional caller-assigned unique identity. Rejected at create time if a
     * routine already uses it (the column is UNIQUE). */
    key?: string;
    /** The owning app's id. Set to mark this routine as app-managed — a managed
     * routine can only be deleted by passing the same id back as `actor`. */
    managedBy?: string;
    trigger: Trigger;
    actionName: string;
    args: Record<string, unknown>;
    enabled?: boolean;
    nextRunAt?: Date;
  }): Promise<string>;
  listRoutines(): Promise<Routine[]>;
  /** Look up a routine by its caller-assigned `key`, or null if unused. */
  findByKey(key: string): Promise<Routine | null>;
  /** Delete only if the routine has no in-flight (`running` /
   * `pending_approval`) runs; check + delete are atomic. A managed routine
   * (`managedBy` set) is refused unless `actor` equals the owning app's id. */
  deleteIfNoActiveRuns(id: string, actor?: string): Promise<DeleteRoutineResult>;
}

export interface RoutineEngine {
  activate(routine: Routine): Promise<void>;
  /** Async because a worker reaches the engine over RPC. Even though the
   * main-process teardown itself is synchronous, callers must `await` so a
   * worker's cancel completes (and surfaces IPC errors) before they report
   * success — otherwise the `*Proxy` would be fire-and-forget behind a sync
   * signature. */
  deactivate(routineId: string): Promise<void>;
}

export interface EventPublisher {
  publish(event: {
    name: string;
    source: string;
    payload?: Record<string, unknown>;
  }): Promise<{ accepted: true }>;
}

export interface EventCatalogReader {
  search(query: string, limit: number): Promise<{ entries: EventCatalogEntry[]; total: number }>;
}

/** A system-initiated turn re-enters an established session rather than
 * handling an inbound message. Unlike inbound, it skips the trust pipeline
 * (policy / sentinel / person) — trust was settled when the session began. */
export interface BackendTurnParams {
  /** Agent whose session is continued. */
  agentName: string;
  /** Exact runtime session resume handle. */
  sessionId: string;
  /** Connection that owns the provider conversation. Required for non-webchat delivery. */
  connectionId?: string;
  channel: string;
  threadId: string;
  /** Recipient id on the channel, used as the reply target where the channel
   * needs one (messaging adapters). Optional for webchat. */
  channelUserId?: string;
  /** The text fed to the continued turn as its prompt. */
  prompt: string;
}

/** Runs a backend turn in a session and delivers the reply to its channel.
 * The real implementation lives in the
 * main process — it owns the AgentSession registry, the channel adapters, and
 * the webchat runtime; a worker-side action receives a proxy that forwards the
 * single `session.continue` call over WorkerRPC. One method, every channel: the
 * per-channel delivery branch lives inside the implementation, not at callers. */
export interface BackendTurnRunner {
  runAndDeliver(params: BackendTurnParams): Promise<void>;
}

/** App lifecycle authority (create / install / uninstall / enable). Results are
 * app-local shapes the caller knows, so they cross this surface as `unknown` and
 * the caller narrows — the SDK stays free of the concrete result types.
 * `install` takes no appId: the daemon derives it from the source (manifest id
 * for local sources, listing slug for appstore) and returns it in the result. */
export type AppLifecycleCreateParams =
  | {
      appId: string;
      rootPath: string;
      template?: "default" | "workflow";
      from?: never;
      name?: never;
    }
  | {
      appId: string;
      name: string;
      /** Copies local installed code or downloads a pinned Store bundle; never installs the source. */
      from:
        | {
            appId: string;
            /** Reject a source changed since the user confirmed this Store version. */
            expectedSource?: { listingId: string; version: string; contentHash: string };
          }
        | { listingId: string; version: string; contentHash: string };
      rootPath?: never;
      template?: never;
    };

export interface AppLifecycle {
  create(params: AppLifecycleCreateParams): Promise<unknown>;
  install(params: { source: unknown; enabled?: boolean }): Promise<unknown>;
  uninstall(params: { appId: string; purge?: boolean }): Promise<unknown>;
  setEnabled(params: { appId: string; enabled: boolean }): Promise<unknown>;
}

function shouldLog(level: LogLevel): boolean {
  const currentLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVEL_ORDER[level] >= (LEVEL_ORDER[currentLevel] ?? LEVEL_ORDER.info);
}

export function createAppLogger(component: string): Logger {
  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level)) {
      return;
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
    };

    if (data !== undefined) {
      entry.data = data;
    }

    const line = JSON.stringify(entry);
    switch (level) {
      case "debug":
      case "info":
        console.log(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
        console.error(line);
        break;
    }
  }

  return {
    debug: (message, data) => log("debug", message, data),
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
  };
}
