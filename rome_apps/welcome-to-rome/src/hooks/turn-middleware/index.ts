import type {
  AgentMessage,
  TurnMiddlewareContext,
  TurnMiddlewareHook,
  TurnMiddlewareHookDeps,
  TurnMiddlewareNext,
  TurnOutcome,
} from "@rome-os/app-runtime";
import { createProgressRepository } from "../../db/repositories/progress.js";
import {
  closingMessageAfterBuild,
  finishBuild,
  isBuilderAgent,
  isOnboardingBuildTurn,
  runTurn,
  startBuild,
  type TurnReply,
  type WelcomeEffects,
  webchatThreadId,
} from "./script.js";
import { emitComponent, emitAskQuestion, emitConnectAi, emitHandoff } from "./component.js";
import type { SummonResult } from "./script.js";
import { copyFor } from "./copy.js";
import { normalizeWelcomeLocale, type WelcomeLocale } from "../../locale.js";

const AGENT_NAME = "welcome-to-rome";

// Closing messages still posting, by build chat, each resolving with whether it
// posted. A later turn there waits on it instead of posting it twice. Installing
// the first app reloads the hook, and core imports it afresh each time, so this
// lives on the process rather than on the hook or the module.
const CLOSING_POSTS = Symbol.for("rome.welcome-to-rome.closing-posts");
const closingPosts: Map<string, Promise<boolean>> = ((
  globalThis as { [CLOSING_POSTS]?: Map<string, Promise<boolean>> }
)[CLOSING_POSTS] ??= new Map());

/** Cap the inline idea brainstorm so a stuck specialist can't hang the turn —
 *  on timeout we fall back to generic starter ideas. */
const SUMMON_TIMEOUT_MS = 90_000;

/** How long the build turn's tail waits for the closing message to post. The
 *  chat's next turn waits on this one, so a slow channel can't hold it up;
 *  a post that lands later still ends onboarding. */
const CLOSING_MESSAGE_TIMEOUT_MS = 10_000;

/** How long a closing message may take to post before the welcome gives up on
 *  it, so a post that never settles can't leave onboarding waiting for good.
 *  The next finished build turn tries again. */
const CLOSING_POST_CEILING_MS = 60_000;

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
 * passes straight through to the model via `next()`, and the onboarding build
 * turn gets the welcome's closing message posted after it.
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
      const buildThreadId = await this.claimBuildTurn(ctx);
      const outcome = await next();
      if (buildThreadId) await this.postClosingMessage(ctx, buildThreadId, outcome);
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
   *  - `handoff`: an optional lead-in, then the floor passes to another agent in
   *    this same chat.
   *  - `none`: nothing; core closes the turn with an empty result.
   *  A parked turn emits NO terminal `result` — the card's result arrives as
   *  the next turn. */
  private async emitReply(ctx: TurnMiddlewareContext, reply: TurnReply): Promise<void> {
    const emit = (event: AgentMessage) => ctx.emit(event);
    if (reply.kind === "none") return;
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
    } else if (reply.kind === "handoff") {
      const { agentName, agentLabel, brief } = reply;
      emitHandoff(emit, { agentName, agentLabel, brief });
    } else {
      emitComponent(emit, reply.componentId, reply.props);
    }
  }

  /** When this turn belongs to the build of the guardian's first app, return
   *  the build chat's id, and on the build's first turn, record it. Every
   *  agent's turns pass through here, so anything but the builder in a webchat
   *  chat returns before any read. A failed check reads as no, so ordinary
   *  chat never depends on the welcome. */
  private async claimBuildTurn(ctx: TurnMiddlewareContext): Promise<string | null> {
    if (!isBuilderAgent(ctx.session.agentName)) return null;
    const threadId = webchatThreadId(ctx.session.channelThreadKey);
    const db = this.deps.appContext?.db;
    if (!threadId || !db) return null;
    try {
      const progress = createProgressRepository(db);
      const turn = { agentName: ctx.session.agentName, threadId, prompt: ctx.input.prompt ?? "" };
      if (!isOnboardingBuildTurn(progress.get(), turn)) return null;
      startBuild(progress, threadId);
      return threadId;
    } catch {
      return null;
    }
  }

  /** After a build turn, post the welcome's closing message as its own
   *  message, once the build has finished, and end onboarding once it posts. A
   *  turn's stream ends with its reply, so the message goes through the chat's
   *  channel instead. A failed post leaves onboarding waiting on the build, so
   *  the next finished turn there tries again. A post that outlasts the ceiling
   *  may still land, and the send can't be cancelled, so the welcome ends as
   *  though it had posted and nothing posts it again. */
  private async postClosingMessage(
    ctx: TurnMiddlewareContext,
    threadId: string,
    outcome: TurnOutcome | undefined,
  ): Promise<void> {
    const appContext = this.deps.appContext;
    if (!appContext?.db || closingPosts.has(threadId)) return;
    const db = appContext.db;
    const warn = (detail: Record<string, unknown>) =>
      this.deps.logger.warn("welcome-to-rome could not post the closing message", {
        sessionId: ctx.session.id,
        ...detail,
      });
    // Progress is read after the locale, right before the post, so a handoff
    // the guardian closed or a start over during the lookup posts nothing.
    const locale = await this.getLocale();
    let text: string | null;
    try {
      text = closingMessageAfterBuild(
        createProgressRepository(db).get(),
        locale,
        threadId,
        outcome,
      );
    } catch (err) {
      warn({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!text) return;

    const sending = (async () => {
      try {
        const sent = await appContext.runAction("send_message", {
          channel: "webchat",
          threadId,
          text,
        });
        if (sent.status !== "ok") {
          warn({ status: sent.status });
          return false;
        }
        finishBuild(createProgressRepository(db), threadId);
        return true;
      } catch (err) {
        warn({ error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    })();
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    const posting = Promise.race([
      sending,
      new Promise<boolean>((resolve) => {
        ceiling = setTimeout(() => {
          warn({ error: "timed out" });
          try {
            finishBuild(createProgressRepository(db), threadId);
          } catch (err) {
            warn({ error: err instanceof Error ? err.message : String(err) });
          }
          resolve(true);
        }, CLOSING_POST_CEILING_MS);
      }),
    ]).finally(() => {
      clearTimeout(ceiling);
      if (closingPosts.get(threadId) === posting) closingPosts.delete(threadId);
    });
    closingPosts.set(threadId, posting);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSING_MESSAGE_TIMEOUT_MS);
    });
    await Promise.race([posting, timeout]);
    clearTimeout(timer);
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
      closingInFlight: (threadId) => closingPosts.get(threadId) ?? null,
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
