import type {
  AgentMessage,
  TurnMiddlewareContext,
  TurnMiddlewareHook,
  TurnMiddlewareHookDeps,
  TurnMiddlewareNext,
} from "@rome-os/app-runtime";
import { createTracesRepository } from "../../db/repositories/traces.js";
import { createPlansRepository, type Plan } from "../../db/repositories/plans.js";
import { createSessionsRepository } from "../../db/repositories/sessions.js";
import {
  blockToAgentMessage,
  isTerminalBlock,
  parseTrace,
  type TraceBlock,
} from "../../lib/trace.js";

const AGENT_NAME = "replay";

// Typewriter pacing: stream each `text` block word-by-word
// as transient `text_delta` previews, then the whole `text` block that persists.
// These are the 1× cadence — tuned for a calm, readable feel, like watching the
// assistant think out loud — and every delay is divided by the plan's speed.
const TYPE_WORD_MS = 55;
const TYPE_SENTENCE_PAUSE_MS = 260;
// Beat before each block (a text message, a thinking block, a tool pair) so
// successive messages land one at a time instead of cascading instantly.
const BLOCK_GAP_MS = 320;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Derive the webchat session id the replay was bound to. `ctx.session.id` is
 * the AgentSession id, NOT the webchat session id the web UI bound the plan
 * with — but the webchat id is the second segment of the channelThreadKey
 * (`webchat:<sessionId>[:large-model:<model>]`, built in
 * `packages/core/src/api/routes/webchat.ts`). Session ids are UUIDs, so they
 * never contain a colon and the segment is unambiguous.
 */
function webchatSessionId(channelThreadKey: string): string | null {
  const parts = channelThreadKey.split(":");
  return parts[0] === "webchat" && parts[1] ? parts[1] : null;
}

/**
 * Paces one turn from the plan's playback settings: every wait is divided by
 * `speed`, and `budgetMs` caps the wall-clock time a turn may spend pacing —
 * once spent, waits no-op and the rest of the turn emits instantly. The budget
 * counts post-scaling time, so it caps real time at any speed. The web driver
 * plays turns sequentially (posts the next turn only after this one finishes —
 * see App.tsx), so a slow turn never stalls queued turns; the budget only
 * guards against a single pathologically long trace typing for minutes.
 */
class Pacer {
  private spent = 0;
  constructor(
    private readonly budgetMs: number,
    private readonly speed: number,
  ) {}
  async wait(ms: number): Promise<void> {
    if (this.spent >= this.budgetMs) return;
    const scaled = ms / this.speed;
    this.spent += scaled;
    await sleep(scaled);
  }
}

/**
 * Emit `text` with a typewriter effect: stream it word-by-word as transient
 * `text_delta` previews (webchat accumulates these into a live tail), then the
 * whole `text` block that actually persists. Mirrors welcome-to-rome's typeOut.
 */
async function typeOut(
  emit: (event: AgentMessage) => void,
  text: string,
  turnPhase: "commentary" | "final" | undefined,
  pacer: Pacer,
): Promise<void> {
  const block: AgentMessage = turnPhase
    ? { type: "text", content: text, turnPhase }
    : { type: "text", content: text };
  if (!text) {
    emit(block);
    return;
  }
  const tokens = text.match(/\S+\s*/g);
  if (!tokens) {
    emit(block);
    return;
  }
  for (const token of tokens) {
    emit({ type: "text_delta", content: token });
    await pacer.wait(/[.!?:…\n]\s*$/.test(token) ? TYPE_SENTENCE_PAUSE_MS : TYPE_WORD_MS);
  }
  emit(block);
}

/**
 * Replay turn-middleware. Every turn on a `replay` session replays
 * the next recorded trace in the bound plan: each block is inverse-mapped back
 * into an `AgentMessage` and re-emitted (typewriter pacing for text), exactly
 * one terminal block per turn. The model is never called. Every other session
 * passes straight through via `next()`.
 */
class ReplayTurnMiddleware implements TurnMiddlewareHook {
  readonly order = 100;
  // We catch our own failures and emit a scripted fallback, so the chain never
  // sees a throw — but declare fail-open so a bug can't ever break normal chat.
  readonly onError = "fail-open" as const;

  constructor(private readonly deps: TurnMiddlewareHookDeps) {}

  async handle(ctx: TurnMiddlewareContext, next: TurnMiddlewareNext): Promise<void> {
    if (ctx.session.agentName !== `${this.deps.appId}:${AGENT_NAME}`) {
      await next();
      return;
    }
    try {
      await this.replayTurn(ctx);
    } catch (err) {
      this.deps.logger.warn("replay turn failed; emitting fallback", {
        sessionId: ctx.session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.emitText(ctx, "Something went wrong replaying this trace.");
    }
    // Deliberately do NOT call next(): the model is never invoked for this turn.
  }

  private async replayTurn(ctx: TurnMiddlewareContext): Promise<void> {
    const appContext = this.deps.appContext;
    if (!appContext?.db) throw new Error("replay middleware requires appContext.db");

    const webId = webchatSessionId(ctx.session.channelThreadKey);
    if (!webId) {
      this.emitText(ctx, "Replay is only available from a webchat session.");
      return;
    }

    const sessionsRepo = createSessionsRepository(appContext.db);
    const binding = await sessionsRepo.get(webId);
    if (!binding) {
      this.emitText(
        ctx,
        "This chat isn't bound to a replay plan. Start a replay from the Replay app.",
      );
      return;
    }

    const plan = await createPlansRepository(appContext.db).byId(binding.planId);
    if (!plan || plan.traceIds.length === 0) {
      this.emitText(ctx, "The replay plan for this chat is empty or missing.");
      return;
    }

    if (binding.cursor >= plan.traceIds.length) {
      this.emitText(ctx, "Replay finished — every trace in this plan has been played.");
      return;
    }

    const traceId = plan.traceIds[binding.cursor];
    const trace = await createTracesRepository(appContext.db).byId(traceId);
    if (!trace) {
      // The trace was deleted after the plan was built. Skip it but still
      // advance so a later trace in the plan can play on the next turn.
      await sessionsRepo.advanceCursor(webId);
      this.emitText(ctx, "This step's trace is no longer available; it was skipped.");
      return;
    }

    const { blocks } = parseTrace(trace.contentJson);
    await this.emitTrace(ctx, blocks, plan);
    await sessionsRepo.advanceCursor(webId);
  }

  /** Inverse-map and re-emit every block in order. Exactly one terminal
   *  block finalizes the turn. */
  private async emitTrace(
    ctx: TurnMiddlewareContext,
    blocks: TraceBlock[],
    plan: Plan,
  ): Promise<void> {
    const emit = (event: AgentMessage) => ctx.emit(event);
    const pacer = new Pacer(plan.turnBudgetMs, plan.speed);
    let finalText = "";
    let emittedTerminal = false;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const message = blockToAgentMessage(block, i);
      if (!message) continue; // lifecycle block — not a middleware's to emit

      if (message.type === "text") {
        if (message.turnPhase === "final") finalText = message.content;
        // Beat before starting a message so consecutive commentary bubbles
        // arrive one at a time rather than stacking instantly.
        if (i > 0) await pacer.wait(BLOCK_GAP_MS);
        await typeOut(emit, message.content, message.turnPhase, pacer);
        continue;
      }
      if (message.type === "thinking") {
        await pacer.wait(BLOCK_GAP_MS);
        emit(message);
        continue;
      }
      if (isTerminalBlock(block)) {
        // Exactly one terminal finalizes the turn (see method doc). Emit it and
        // stop: any later blocks belong to a concatenated multi-turn trace or
        // post-terminal recording garbage, and replaying them would leak a
        // second terminal / trailing junk into the transcript.
        emit(message);
        emittedTerminal = true;
        break;
      }
      await pacer.wait(BLOCK_GAP_MS);
      emit(message);
    }

    // A well-formed trace ends with exactly one result/error. If the recording
    // somehow lacks one, synthesize a terminal `result` so the turn finalizes
    // (an unterminated turn never produces a persisted assistant row).
    if (!emittedTerminal) {
      emit({ type: "result", content: finalText });
    }
  }

  /** Emit a one-off plain-text reply with its terminal `result` (used for the
   *  defensive "no plan / finished / error" paths). */
  private emitText(ctx: TurnMiddlewareContext, text: string): void {
    ctx.emit({ type: "text", content: text, turnPhase: "final" });
    ctx.emit({ type: "result", content: text });
  }
}

export function createHook(deps: TurnMiddlewareHookDeps): TurnMiddlewareHook {
  return new ReplayTurnMiddleware(deps);
}
