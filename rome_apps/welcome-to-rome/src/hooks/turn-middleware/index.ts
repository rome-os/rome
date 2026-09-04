import type {
  AgentMessage,
  TurnMiddlewareContext,
  TurnMiddlewareHook,
  TurnMiddlewareHookDeps,
  TurnMiddlewareNext,
} from "@rome-os/app-runtime";
import { createProgressRepository } from "../../db/repositories/progress.js";
import { runTurn, type TurnReply, type WelcomeEffects } from "./script.js";
import { emitComponent, emitAskQuestion, emitConnectAi } from "./component.js";
import type { SummonResult } from "./script.js";
import { copyFor } from "./copy.js";
import { normalizeWelcomeLocale, type WelcomeLocale } from "../../locale.js";

const AGENT_NAME = "welcome-to-rome";

/** Cap the inline idea brainstorm so a stuck specialist can't hang the turn —
 *  on timeout we fall back to generic starter ideas. */
const SUMMON_TIMEOUT_MS = 90_000;

// Typewriter pacing for narration. We stream each text block as incremental
// `text_delta` previews before the whole `text` block, so the guardian sees it
// being "typed" rather than appearing all at once. Deliberately gentle — this
// is a welcome, not a status spinner.
const TYPE_WORD_MS = 34;
const TYPE_SENTENCE_PAUSE_MS = 150;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Emit `text` with a typewriter effect: stream it word-by-word as transient
 * `text_delta` previews (webchat accumulates these into a live tail), then the
 * whole `text` block that actually persists. A slightly longer pause trails
 * sentence-ending punctuation for a natural cadence.
 */
async function typeOut(
  emit: (event: AgentMessage) => void,
  text: string,
  turnPhase: "commentary" | "final",
): Promise<void> {
  if (!text) return;
  // "word + its trailing whitespace" tokens; concatenated they reproduce `text`.
  const tokens = text.match(/\S+\s*/g);
  if (!tokens) {
    emit({ type: "text", content: text, turnPhase });
    return;
  }
  for (const token of tokens) {
    emit({ type: "text_delta", content: token });
    await sleep(/[.!?:…\n]\s*$/.test(token) ? TYPE_SENTENCE_PAUSE_MS : TYPE_WORD_MS);
  }
  emit({ type: "text", content: text, turnPhase });
}

/**
 * welcome-to-rome turn middleware. Intercepts every turn on a
 * `welcome-to-rome` session and produces the reply from a deterministic state
 * machine — the model is never called. The heavy steps (memory, ideas) are
 * delegated to specialist agents via an inline `summon`. Every other session
 * passes straight through to the model via `next()`.
 */
class WelcomeTurnMiddleware implements TurnMiddlewareHook {
  // Ordering is irrelevant while this is the only middleware, but the seam
  // requires an explicit order; pick a mid value to leave room on both sides.
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
      const reply = await runTurn(ctx.input.prompt ?? "", this.makeEffects(ctx));
      await this.emitReply(ctx, reply);
    } catch (err) {
      this.deps.logger.warn("welcome-to-rome turn failed; emitting fallback", {
        sessionId: ctx.session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.emitReply(ctx, {
        kind: "text",
        text: copyFor(await this.getLocale()).unexpectedError,
      });
    }
    // Deliberately do NOT call next(): the model is never invoked for this turn.
  }

  /** Turn a state-machine reply into emitted events.
   *  - `text`: a final block + terminal `result` (the persisted assistant row).
   *  - `component`: an optional commentary lead-in + one of the app's own inline
   *    components (name-card / scout-suggestions / idea-picker).
   *  - `ask`: an optional lead-in + the host's built-in ask_question card.
   *  - `connect_ai`: an optional lead-in + the host's built-in AI tools card.
   *  A parked turn emits NO terminal `result` — the card's result arrives as
   *  the next turn. */
  private async emitReply(ctx: TurnMiddlewareContext, reply: TurnReply): Promise<void> {
    const emit = (event: AgentMessage) => ctx.emit(event);
    if (reply.kind === "text") {
      await typeOut(emit, reply.text, "final");
      ctx.emit({ type: "result", content: reply.text });
      return;
    }
    if (reply.lead && reply.lead.trim()) {
      await typeOut(emit, reply.lead, "commentary");
    }
    if (reply.kind === "ask") {
      emitAskQuestion(emit, reply.questions);
    } else if (reply.kind === "connect_ai") {
      emitConnectAi(emit);
    } else {
      emitComponent(emit, reply.componentId, reply.props);
    }
  }

  private makeEffects(ctx: TurnMiddlewareContext): WelcomeEffects {
    const appContext = this.deps.appContext;
    if (!appContext?.db) {
      throw new Error("welcome-to-rome middleware requires appContext.db");
    }
    return {
      progress: createProgressRepository(appContext.db),
      getAgentName: async () => {
        try {
          const value = await appContext.repositories.settings.get<string>("agentName");
          return (typeof value === "string" && value.trim()) || "Rome";
        } catch {
          return "Rome";
        }
      },
      getGuardianName: async () => {
        try {
          const value = await appContext.repositories.settings.get<string>("guardianName");
          return (typeof value === "string" && value.trim()) || null;
        } catch {
          return null;
        }
      },
      writeNames: (names) => this.writeNames(names),
      getLocale: () => this.getLocale(),
      // Intermediate narration, typed out: a commentary block streams in word by
      // word (text_delta previews) then persists, so the UI feels alive while a
      // slow step (the memory fold) runs. Awaited by callers to keep
      // ordering against the emits that follow.
      say: (text: string) => typeOut((event) => ctx.emit(event), text, "commentary"),
      summon: (agentName, prompt) => this.summon(agentName, prompt),
    };
  }

  /** Write the confirmed names through the host's guardian profile path, which
   *  updates the settings and the guardian person row together. Without that
   *  repository (an older host) the settings alone are written. */
  private async writeNames(names: {
    guardianName: string;
    agentName: string;
  }): Promise<{ ok: boolean }> {
    const appContext = this.deps.appContext;
    if (!appContext) return { ok: false };
    try {
      const profile = appContext.repositories.guardianProfile;
      if (profile) return await profile.write(names);
      await appContext.repositories.settings.set("guardianName", names.guardianName);
      await appContext.repositories.settings.set("agentName", names.agentName);
      return { ok: true };
    } catch (err) {
      this.deps.logger.warn("welcome-to-rome could not write the names", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false };
    }
  }

  /** Read the server-side language selected by the guardian. */
  private async getLocale(): Promise<WelcomeLocale> {
    const appContext = this.deps.appContext;
    if (!appContext) return "en";
    try {
      return normalizeWelcomeLocale(
        await appContext.repositories.settings.get<unknown>("guardianLanguage"),
      );
    } catch {
      return "en";
    }
  }

  /** Run a specialist agent inline (non-interactive summon) and return its
   *  structured output. Failures (no appContext, action error, timeout, throw)
   *  resolve to `{ ok: false }` so the caller can fall back gracefully — the
   *  brainstorm must never break onboarding. */
  private async summon(agentName: string, prompt: string): Promise<SummonResult> {
    const appContext = this.deps.appContext;
    if (!appContext) return { ok: false, output: undefined };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SUMMON_TIMEOUT_MS);
      });
      const outcome = await Promise.race([
        appContext.runAction("summon", { agentName, prompt }),
        timeout,
      ]);
      if (outcome === "timeout") {
        this.deps.logger.warn("welcome-to-rome summon timed out", { agentName });
        return { ok: false, output: undefined };
      }
      if (outcome.status !== "ok") {
        this.deps.logger.warn("welcome-to-rome summon did not return ok", {
          agentName,
          status: outcome.status,
        });
        return { ok: false, output: undefined };
      }
      const data = (outcome.data ?? {}) as { output?: unknown };
      return { ok: true, output: data.output };
    } catch (err) {
      this.deps.logger.warn("welcome-to-rome summon threw", {
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, output: undefined };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function createHook(deps: TurnMiddlewareHookDeps): TurnMiddlewareHook {
  return new WelcomeTurnMiddleware(deps);
}
