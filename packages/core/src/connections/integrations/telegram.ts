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

import { Bot, GrammyError } from "grammy";
import { z } from "zod";
import type { TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import { TelegramAdapter, type CreateTelegramBot } from "../../channels/telegram.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { tokenPaste } from "../schemes.js";
import type { SetupFn } from "../setup/types.js";
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
  /** Injectable identity probe for the setup: validates the pasted token
   *  AND returns the bot's getMe identity in one call. Production hits the
   *  Telegram Bot API (honoring the setup's abort signal); tests inject a fake.
   *  Throws (with a guardian-readable message) when the token is refused. */
  probeBotIdentity?: (
    token: string,
    signal?: AbortSignal,
  ) => Promise<{ botId: string; botUsername: string }>;
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

export function makeTelegramSetup(deps: {
  probeBotIdentity: (
    token: string,
    signal?: AbortSignal,
  ) => Promise<{ botId: string; botUsername: string }>;
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

    const profile =
      telegramProfileFromSettings({ botId: identity.botId, botUsername: identity.botUsername }) ??
      undefined;
    return {
      credential: { material: { token }, expiresAt: "never" },
      profile,
      summary: {
        title: "Telegram connected",
        body: [
          `${identity.botUsername || "Your bot"} is live. Send it a private message, then approve your account in Settings → Connections or Activity.`,
        ],
      },
    };
  };
}

/**
 * Build the Telegram descriptor. `deps.createBot` is injectable so tests can
 * drive the grammy transport without hitting the network; the setup
 * seams default to the real getMe probe.
 */
export function makeTelegramDescriptor(deps: TelegramDescriptorDeps = {}): ConnectionDescriptor {
  const createBot: CreateTelegramBot = deps.createBot ?? ((token) => new Bot(token));
  const probeBotIdentity =
    deps.probeBotIdentity ?? ((token, signal) => pingTelegramIdentity(createBot, token, signal));
  const botScheme = tokenPaste({
    label: "Telegram bot token",
    instructions: "Paste the bot token from @BotFather.",
    // getMe ping: a 401 here means the pasted token is not accepted.
    validate: async (token: string) => {
      await createBot(token).api.getMe();
    },
  });
  botScheme.setup = makeTelegramSetup({ probeBotIdentity });

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
