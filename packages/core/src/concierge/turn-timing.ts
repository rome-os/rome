// How long a Concierge turn took as its owner sees it: from the send to the
// first sign of work (👀, a reaction or a message), to the first message the
// turn said, and to its end, with what the turn cost in model calls, tool
// calls and tokens. Each turn is recorded once, as Rome metrics and one log
// line. `rome.model.turn.ttft` counts the first plain text, which a
// Concierge turn does not send: it speaks through `say`.
// docs/concierge-eval.md#timing

import type { AgentAccounting } from "@rome-os/app-runtime";
import { bareTool } from "../lib/tool-name.js";
import { createLogger } from "../logger.js";
import { recordConciergeTurnMetrics } from "../telemetry.js";

const log = createLogger("concierge-turn-timing");

/** What started the turn: the owner's message, or Rome (a task result, a digest, a routine). */
export type TurnTrigger = "guardian" | "system";

/**
 * Whether the chat's agent session was open when the turn asked for it:
 * `warm` reuses it, `cold` opens one, which on Claude spawns the CLI and
 * resumes the thread.
 */
export type SessionWarmth = "warm" | "cold";

export interface TurnTimingStart {
  chatId: string;
  turnId: string;
  trigger: TurnTrigger;
  /** The owner's message the turn took, whose 👀 or reaction is its first sign. */
  messageKey?: string;
  /** When the owner's send reached Rome, or when Rome started the turn, epoch ms. */
  startedAtMs: number;
  /** The effort the turn asked for, when it asked for one. */
  effort?: string;
  session?: SessionWarmth;
}

/** One timed turn, as the log line and the eval read it. Times are ms after `startedAtMs`. */
export interface ConciergeTurnTimed {
  chatId: string;
  turnId: string;
  trigger: TurnTrigger;
  model: string | null;
  effort: string | null;
  session: SessionWarmth | null;
  /** Until the model turn started: session acquire, open, and any wait for a renewal. */
  startMs: number | null;
  /** Until the owner's message showed 👀 working. */
  workingMs: number | null;
  /** Until the turn reacted to the owner's message. */
  reactedMs: number | null;
  /** Until the first message the turn said landed in the chat. */
  firstSayMs: number | null;
  /** Until the first sign the owner saw: 👀, a reaction or a message. */
  ackMs: number | null;
  durationMs: number;
  /** Model calls the turn made, as the provider counts them. */
  modelCalls: number | null;
  toolCalls: number;
  /** Tool calls by bare tool name. */
  tools: Record<string, number>;
  /** The context the turn ended with. */
  contextTokens: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  failed: boolean;
}

/** One event of the turn, as far as its timing reads it. */
export interface TimedEvent {
  type: string;
  tool?: string;
  /** Set on a subagent's events, whose terminals carry their own accounting. */
  agent?: string;
  accounting?: AgentAccounting;
}

const since = (start: number, at: number | undefined) =>
  at === undefined ? null : Math.max(0, at - start);

/** The timing of one running Concierge turn, from its start to its end. */
export class ConciergeTurnTiming {
  private modelStartedAt?: number;
  private workingAt?: number;
  private reactedAt?: number;
  private firstSayAt?: number;
  private toolCalls = 0;
  private readonly tools: Record<string, number> = {};
  private modelCalls: number | null = null;
  private model: string | null = null;
  private context: number | null = null;
  private readonly tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private failed = false;
  private finished = false;

  constructor(
    readonly start: TurnTimingStart,
    private readonly agentName: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The turn streamed `event`. */
  event(event: TimedEvent): void {
    if (event.agent && event.agent !== this.agentName) return;
    if (event.type === "turn_start" || event.type === "model_turn_started") {
      this.modelStartedAt ??= this.now();
    } else if (event.type === "tool_use" && event.tool) {
      const tool = bareTool(event.tool);
      this.toolCalls += 1;
      this.tools[tool] = (this.tools[tool] ?? 0) + 1;
    } else if (event.type === "result" || event.type === "error") {
      if (event.type === "error") this.failed = true;
      const accounting = event.accounting;
      if (!accounting) return;
      this.model = accounting.model;
      this.modelCalls = (this.modelCalls ?? 0) + (accounting.numTurns ?? 1);
      this.context = accounting.context?.usedTokens ?? this.context;
      this.tokens.input += accounting.usage.inputTokens;
      this.tokens.cacheRead += accounting.usage.cacheReadTokens;
      this.tokens.cacheWrite += accounting.usage.cacheWriteTokens;
      this.tokens.output += accounting.usage.outputTokens;
    }
  }

  /** The owner's message started to show 👀 working. */
  working(): void {
    this.workingAt ??= this.now();
  }

  reacted(): void {
    this.reactedAt ??= this.now();
  }

  /** A message the turn said landed in the chat. */
  said(): void {
    this.firstSayAt ??= this.now();
  }

  /**
   * Ends the timing once, and answers what it measured; null when it ended
   * already. `turnId` is the turn's own id, when it learned one after it began.
   */
  finish(turnId = this.start.turnId): ConciergeTurnTimed | null {
    if (this.finished) return null;
    this.finished = true;
    const t0 = this.start.startedAtMs;
    const signs = [this.workingAt, this.reactedAt, this.firstSayAt].filter(
      (at): at is number => at !== undefined,
    );
    return {
      chatId: this.start.chatId,
      turnId,
      trigger: this.start.trigger,
      model: this.model,
      effort: this.start.effort ?? null,
      session: this.start.session ?? null,
      startMs: since(t0, this.modelStartedAt),
      workingMs: since(t0, this.workingAt),
      reactedMs: since(t0, this.reactedAt),
      firstSayMs: since(t0, this.firstSayAt),
      ackMs: signs.length ? since(t0, Math.min(...signs)) : null,
      durationMs: Math.max(0, this.now() - t0),
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      tools: { ...this.tools },
      contextTokens: this.context,
      inputTokens: this.tokens.input,
      cacheReadTokens: this.tokens.cacheRead,
      cacheWriteTokens: this.tokens.cacheWrite,
      outputTokens: this.tokens.output,
      failed: this.failed,
    };
  }
}

/** Records a timed turn: Rome's metrics, and one log line that carries every field. */
export function reportConciergeTurn(timed: ConciergeTurnTimed): void {
  recordConciergeTurnMetrics(timed);
  log.info("concierge.turn.timed", { ...timed, tools: JSON.stringify(timed.tools) });
}
