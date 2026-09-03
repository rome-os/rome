// Telegram connection integration. Channel contract: docs/architecture/channels.md.
//
// Telegram is a Talker with a single `bot` grant (a pasted bot token). The
// transport core — normalization, attachment extraction, send formatting — is
// the existing `TelegramAdapter` (packages/core/src/channels/telegram.ts),
// wrapped here so the runtime's grant-epoch lifecycle and fault→grant-state
// mapping (registry.ts) drive it. grammy owns transient reconnect internally
// (auto-retries dropped long-polls); only TERMINAL failures reach `fault`:
//   - auth failure (401 Unauthorized from getMe/getUpdates/sendMessage) →
//     CredentialRejected{ grant: "bot" } → runtime renews once, then degrades.
//   - any other terminal transport failure → Disconnected → runtime backs off
//     and rebuilds.

import { randomInt } from "node:crypto";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { z } from "zod";
import type { TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import { TelegramAdapter, type CreateTelegramBot } from "../../channels/telegram.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { tokenPaste } from "../schemes.js";
import { SetupAbortError } from "../setup/session.js";
import type { SetupFn, SetupView } from "../setup/types.js";
import type { ConnectionDescriptor, ProfileDisplay, ProfileRecord, Talker } from "../types.js";
import {
  addressIsConversationFeature,
  inboundMediaFeature,
  toInboundMessage,
  toMessageReceipt,
} from "./talk-features.js";

/**
 * True iff `err` is a Telegram "credential refused" — a grammy `GrammyError`
 * with `error_code` 401 ("Unauthorized") from getMe / getUpdates / sendMessage.
 * This is the ONLY signal that maps to grant state; every other
 * grammy/transport error is a `Disconnected`.
 */
export function isTelegramAuthError(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 401;
}

// The `bot` grant's profile — the identity @BotFather reports for the token
// (getMe). Declared next to the material shape ({ token }); the parse OUTPUT is
// exactly what lands on the grant row as the opaque ProfileRecord, and the same
// schema re-runs on revive so a stored record that no longer matches fails loudly
// rather than rendering sparsely. Both fields optional: a token whose getMe
// identity was never captured stays sparse-but-valid.
export const telegramGrantProfileSchema = z
  .object({
    /** Numeric bot id, stringified (owner-side identity; not a display field). */
    botId: z.string().min(1).optional(),
    /** `@handle` from getMe — the bot's public identity. */
    botUsername: z.string().min(1).optional(),
  })
  .strict();
export type TelegramGrantProfile = z.infer<typeof telegramGrantProfileSchema>;

/** Pure display projection: the @handle reads as the bot's handle. `botId` is
 *  owner-side identity and never widens the display surface. */
export function toTelegramDisplay(profile: TelegramGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: undefined,
    handle: profile.botUsername,
    email: undefined,
    avatarUrl: undefined,
  });
}

/** Revive a stored telegram profile: re-parse with the schema, then map through
 *  the pure display function (fail-closed on a record that no longer matches). */
export function reviveTelegramProfile(record: ProfileRecord): ProfileDisplay {
  return toTelegramDisplay(telegramGrantProfileSchema.parse(record));
}

/** The identity fields the telegram settings row carries (getMe output). Values
 *  are untrusted persisted JSON — typed `unknown` so a wrong-typed value reaches
 *  the strict parse instead of being coerced or dropped before it. */
export interface TelegramProfileSource {
  botId?: unknown;
  botUsername?: unknown;
}

/** Build the parsed grant profile from the settings row, or null when the row
 *  carries no identity to record (null / undefined / "" are the absent cases).
 *  Only a string or FINITE-number `botId` is stringified to the schema's string
 *  shape (getMe reports a number); every other present value flows through
 *  untouched so the strict parse rejects it — never coerced into a storable
 *  string like "[object Object]" (fail-closed). */
export function telegramProfileFromSettings(
  settings: TelegramProfileSource,
): TelegramGrantProfile | null {
  const raw: Record<string, unknown> = {};
  const { botId, botUsername } = settings;
  if (typeof botId === "number" && Number.isFinite(botId)) {
    raw.botId = String(botId);
  } else if (botId != null && botId !== "") {
    raw.botId = botId;
  }
  if (botUsername != null && botUsername !== "") raw.botUsername = botUsername;
  if (Object.keys(raw).length === 0) return null;
  return telegramGrantProfileSchema.parse(raw);
}

/**
 * The runtime deps the Telegram descriptor needs, threaded from index.ts at
 * registration time. `createBot` is the injectable transport factory (production
 * constructs a real grammy `Bot`; the fault-mapping tests inject a fake wired to
 * grammy's transformer seam — see `test/kit/fake-telegram.ts`). The setup
 * seams are injectable so tests drive the ceremony without the network.
 */
export interface TelegramDescriptorDeps {
  createBot?: CreateTelegramBot;
  /** Person-mapping repo the default `guardianLinked` consults (present in
   *  production; setup tests inject `guardianLinked` directly instead). */
  personMappingRepo?: PersonMappingRepository;
  /** Injectable identity probe for the setup: validates the pasted token
   *  AND returns the bot's getMe identity in one call. Production hits the
   *  Telegram Bot API (honoring the setup's abort signal); tests inject a fake.
   *  Throws (with a guardian-readable message) when the token is refused. */
  probeBotIdentity?: (
    token: string,
    signal?: AbortSignal,
  ) => Promise<{ botId: string; botUsername: string }>;
  /** Injectable guardian-link probe for the setup. Long-polls
   *  `getUpdates` on the PENDING (unconferred) token — never the real adapter —
   *  and resolves with the id of the guardian who sends the one-time `code` back
   *  to the bot, so the mapping lands in the same terminal write as the
   *  credential. Must honor the abort signal (cancel interrupts the wait
   *  promptly). Production uses a throwaway grammy bot; tests inject a fake. */
  waitForGuardianLink?: (
    token: string,
    code: string,
    signal: AbortSignal,
  ) => Promise<{ channelUserId: string }>;
  /** True when a guardian already has a telegram channel mapping — re-conferral
   *  then skips the link step (and avoids a `getUpdates` probe competing with a
   *  live adapter for the same token's long-poll — a 409). */
  guardianLinked?: () => Promise<boolean>;
  /** Injectable one-time guardian-link code generator (defaults to a random
   *  six-digit code); tests inject a fixed value. */
  generateVerificationCode?: () => string;
}

/**
 * The guardian-link security gate: a message proves its sender is the guardian
 * ONLY when it comes from a non-bot author and its text is exactly the one-time
 * `code` shown in the dashboard. Requiring the code closes the shared-group hole
 * where any member could race the real guardian by messaging the bot first; a
 * member who cannot see the dashboard code cannot forge the proof. Extracted as a
 * pure predicate so the defense is unit-tested without a live `getUpdates` loop.
 */
export function isTelegramGuardianLinkMessage(
  msg: { from?: { is_bot?: boolean; id?: number }; text?: string },
  code: string,
): boolean {
  if (!msg.from || msg.from.is_bot) return false;
  return typeof msg.text === "string" && msg.text.trim() === code;
}

/** grammy's generated `Api` methods annotate their trailing `signal` param with
 *  the bundled `abort-controller` shim type, structurally the DOM `AbortSignal`
 *  but nominally distinct under tsc. Cast the runtime signal at the call
 *  boundary rather than dragging the shim type through the setup surface. */
type GrammySignal = NonNullable<Parameters<Bot["api"]["getUpdates"]>[1]>;

/** Default identity probe: validate the token via getMe and return the bot's id
 *  + `@handle` for the grant profile. The abort signal threads into the grammy
 *  call so a cancel interrupts the in-flight request. */
async function pingTelegramIdentity(
  createBot: CreateTelegramBot,
  token: string,
  signal?: AbortSignal,
): Promise<{ botId: string; botUsername: string }> {
  const me = await createBot(token).api.getMe(signal as GrammySignal | undefined);
  return { botId: String(me.id), botUsername: me.username ? `@${me.username}` : "" };
}

/**
 * Default guardian-link probe: a throwaway grammy bot long-polling `getUpdates`
 * on the PENDING token. It resolves with the sender of the first message whose
 * text is exactly the expiring one-time `code` shown in the dashboard — NOT
 * merely the first person to message the bot (see isTelegramGuardianLinkMessage).
 * Non-matching messages are ignored and the loop continues. The wait is
 * cancellable via the abort signal (threaded into each `getUpdates` call, and the
 * setup runtime also races the abort so a hung long-poll never wedges a cancel).
 *
 * A 409 Conflict means another `getUpdates` consumer — a live adapter still
 * polling this same token — holds the exclusive long-poll; surface a
 * guardian-readable failure (disconnect the running bot first). The
 * `guardianLinked` skip in the setup means re-conferral of an already-linked bot
 * never reaches this probe, so the 409 only bites the rare fresh-link-over-live
 * case.
 */
export async function waitForTelegramGuardianLink(
  createBot: CreateTelegramBot,
  token: string,
  code: string,
  signal: AbortSignal,
): Promise<{ channelUserId: string }> {
  const bot = createBot(token);
  let offset: number | undefined;
  for (;;) {
    if (signal.aborted) throw new SetupAbortError();
    let updates: Update[];
    try {
      updates = await bot.api.getUpdates(
        { offset, timeout: 30, allowed_updates: ["message"] },
        signal as GrammySignal,
      );
    } catch (err) {
      if (signal.aborted) throw new SetupAbortError();
      if (err instanceof GrammyError && err.error_code === 409) {
        // getUpdates 409s in two distinct cases: another getUpdates consumer (a
        // live adapter still polling this token) OR a webhook set on the token.
        // The remediation differs, so branch on the description rather than
        // sending the guardian down the wrong path.
        const webhookActive = /webhook/i.test(err.description ?? "");
        throw new Error(
          webhookActive
            ? "A webhook is set on this bot token, which blocks the connect probe. " +
                "Remove the webhook (deleteWebhook) before connecting."
            : "This bot token is already connected and running. Disconnect the existing " +
                "Telegram connection first, then reconnect.",
        );
      }
      throw err;
    }
    for (const update of updates) {
      // Advance past every seen update so a wrong-code message isn't redelivered
      // on the next poll (Telegram drops acknowledged updates server-side).
      offset = update.update_id + 1;
      const message = update.message;
      if (message && isTelegramGuardianLinkMessage(message, code)) {
        // Confirm the winning update before returning so Telegram drops it
        // server-side. Otherwise the live adapter — which starts via
        // bot.start() WITHOUT drop_pending_updates — re-fetches the guardian's
        // code message right after conferral and the agent processes a stray
        // "NNNNNN". Best-effort: a failed ack only falls back to that
        // redelivery, and the credential is conferred regardless.
        await bot.api.getUpdates({ offset, timeout: 0 }, signal as GrammySignal).catch(() => {});
        return { channelUserId: String(message.from!.id) };
      }
    }
  }
}

/** A random six-digit guardian-link code from a CSPRNG. The code is the sole
 *  proof binding a Telegram account as guardian (it closes the shared-group
 *  race), so it must not come from a predictable PRNG. (Discord/Feishu still
 *  mint theirs with Math.random(); folding all three onto a shared CSPRNG helper
 *  is a worthwhile follow-up beyond this cutover.) */
function sixDigitCode(): string {
  return String(randomInt(100000, 1000000));
}

/** True when any guardian person already carries a telegram channel mapping. */
async function telegramGuardianLinked(repo: PersonMappingRepository): Promise<boolean> {
  const guardians = await repo.findByBondLevel("guardian");
  return guardians.some((g) => g.channelMappings.some((m) => m.channel === "telegram"));
}

/** The one-time-code view the guardian sends back to the bot. Server-authored so
 *  the standard renderer shows it without any Telegram-specific knowledge. */
function guardianLinkView(botUsername: string, code: string): SetupView {
  const bot = botUsername || "your bot";
  return {
    title: "Link your account",
    body: [
      `Your bot ${bot} is verified.`,
      "To finish linking your account as guardian, send this exact code to the bot in Telegram:",
      code,
    ],
    steps: [{ text: `Send ${code} to ${bot} in Telegram` }],
    progress: true,
  };
}

/**
 * Build the Telegram conferral setup. A linear coroutine:
 *   1. prompt the bot token (re-prompt on a refused token, carrying the error),
 *   2. probe it (getMe) for the bot identity,
 *   3. unless a guardian is already mapped, show the one-time code and `ctx.step`
 *      a `getUpdates` probe on the PENDING token until the guardian sends it back,
 *   4. return the terminal conferral: credential + profile + guardian mapping.
 * The runtime performs the single durable write from the returned conferral —
 * the bespoke flow's pre-conferral `telegram_verification` settings write is gone
 * (the code lives in setup state).
 */
export function makeTelegramSetup(deps: {
  probeBotIdentity: (
    token: string,
    signal?: AbortSignal,
  ) => Promise<{ botId: string; botUsername: string }>;
  waitForGuardianLink: (
    token: string,
    code: string,
    signal: AbortSignal,
  ) => Promise<{ channelUserId: string }>;
  /** True when a guardian is already mapped — skip the link step on re-conferral. */
  guardianLinked: () => Promise<boolean>;
  /** Mints the one-time guardian-link code shown in the dashboard. */
  generateCode: () => string;
}): SetupFn {
  return async (interact, ctx) => {
    let error: string | undefined;
    let token: string;
    let identity: { botId: string; botUsername: string };
    for (;;) {
      ({ token } = await interact.prompt({
        instructions: "Create a Telegram bot with @BotFather, then paste its token below.",
        steps: [
          {
            text: "Open Telegram and start a chat with @BotFather, the official bot for creating bots.",
          },
          {
            text: 'Send /newbot and follow the prompts to set a display name and a username (the username must end in "bot").',
          },
          { text: "BotFather replies with your bot token — copy it and paste it below." },
        ],
        links: [{ label: "Open @BotFather", url: "https://t.me/BotFather" }],
        fields: [{ name: "token", label: "Telegram bot token", secret: true }],
        ...(error ? { error } : {}),
      }));
      try {
        // Thread the setup's abort signal into the probe so a cancel interrupts
        // the in-flight validation rather than waiting for it to return.
        identity = await deps.probeBotIdentity(token, ctx.signal);
        break;
      } catch (err) {
        // A cancel that aborted the probe must unwind the setup, not re-prompt.
        if (ctx.signal.aborted) throw err;
        error = err instanceof Error ? err.message : "Invalid bot token.";
      }
    }

    // Guardian link inside the setup: skipped when a guardian mapping already
    // exists (re-conferral of a rotated token), so the getUpdates probe never
    // competes with the live adapter for the same token's long-poll (409).
    let guardianChannelUserId: string | undefined;
    if (!(await deps.guardianLinked())) {
      const code = deps.generateCode();
      interact.show(guardianLinkView(identity.botUsername, code));
      ({ channelUserId: guardianChannelUserId } = await ctx.step(
        "telegram-guardian-link",
        (signal) => deps.waitForGuardianLink(token, code, signal),
      ));
    }

    const profile =
      telegramProfileFromSettings({ botId: identity.botId, botUsername: identity.botUsername }) ??
      undefined;
    return {
      credential: { material: { token }, expiresAt: "never" },
      profile,
      ...(guardianChannelUserId !== undefined ? { guardianChannelUserId } : {}),
      summary: {
        title: "Telegram connected",
        body: [
          guardianChannelUserId !== undefined
            ? `${identity.botUsername || "Your bot"} is live and your account is linked as guardian.`
            : `${identity.botUsername || "Your bot"} is live.`,
        ],
      },
    };
  };
}

/**
 * Build the Telegram descriptor. `deps.createBot` is injectable so tests can
 * drive the grammy transport without hitting the network; the setup
 * seams default to the real getMe / getUpdates probes.
 */
export function makeTelegramDescriptor(deps: TelegramDescriptorDeps = {}): ConnectionDescriptor {
  const createBot: CreateTelegramBot = deps.createBot ?? ((token) => new Bot(token));
  const probeBotIdentity =
    deps.probeBotIdentity ?? ((token, signal) => pingTelegramIdentity(createBot, token, signal));
  const waitForGuardianLink =
    deps.waitForGuardianLink ??
    ((token: string, code: string, signal: AbortSignal) =>
      waitForTelegramGuardianLink(createBot, token, code, signal));
  const guardianLinked =
    deps.guardianLinked ??
    (deps.personMappingRepo
      ? () => telegramGuardianLinked(deps.personMappingRepo as PersonMappingRepository)
      : async () => false);
  const generateCode = deps.generateVerificationCode ?? sixDigitCode;

  const botScheme = tokenPaste({
    label: "Telegram bot token",
    instructions: "Paste the bot token from @BotFather.",
    // getMe ping: a 401 here means the pasted token is not accepted.
    validate: async (token: string) => {
      await createBot(token).api.getMe();
    },
  });
  // The Telegram conferral setup: prompt the bot token, probe getMe,
  // then (unless a guardian is already mapped) show the one-time code and run a
  // getUpdates probe on the PENDING token until the guardian sends it back,
  // before the single terminal write of credential + profile + guardian mapping.
  botScheme.setup = makeTelegramSetup({
    probeBotIdentity,
    waitForGuardianLink,
    guardianLinked,
    generateCode,
  });

  return {
    service: "telegram",
    reviveProfile: (_grant, record) => reviveTelegramProfile(record),
    auth: {
      bot: botScheme,
    },
    capabilities: {
      talker: {
        needs: ["bot"] as const,
        build(creds): Talker {
          const token = creds.bot.material as { token: string };
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          const routeFault = (err: unknown): void => {
            faultSink?.(
              isTelegramAuthError(err)
                ? new CredentialRejected({ grant: "bot", cause: err })
                : new Disconnected(err),
            );
          };

          const adapter = new TelegramAdapter(
            { botToken: token.token, onPollingError: routeFault },
            createBot,
          );

          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onMessage(async (msg) => deliver(toInboundMessage(msg)));
              // adapter.start() awaits bot.init() (getMe), so a bad token rejects
              // here; the long-poll loop routes its terminal errors through
              // onPollingError → routeFault.
              adapter.start().catch(routeFault);
            },
            stop(): Promise<void> {
              // Return the drain promise so graceful shutdown (registry.stopAll)
              // can await grammy's bot.stop() letting in-flight sends / the
              // long-poll finish; relock teardown ignores the return value.
              return adapter.stop();
            },
            async send(conversationId, msg) {
              try {
                return toMessageReceipt(
                  conversationId,
                  await adapter.sendMessage(conversationId, conversationId, msg),
                );
              } catch (err) {
                // A 401 from sendMessage is a refused credential,
                // surfaced as CredentialRejected so the runtime renews/degrades.
                if (isTelegramAuthError(err)) {
                  throw new CredentialRejected({ grant: "bot", cause: err });
                }
                throw err;
              }
            },
            feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
              const features: Partial<TalkFeatureMap> = {
                inboundMedia: inboundMediaFeature(adapter),
                // A Telegram private chat carries the user's own id as its chat
                // id, so the address is already the conversation.
                directMessaging: addressIsConversationFeature(),
              };
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
          };
        },
      },
    },
  };
}
