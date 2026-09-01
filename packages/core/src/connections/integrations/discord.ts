// Discord connection integration. Channel contract: docs/architecture/channels.md.
//
// Discord is a Talker with a single `bot` grant (a pasted bot token). The
// transport core — gateway lifecycle, normalization, slash commands, send
// formatting, history — is the existing `DiscordAdapter`
// (packages/core/src/channels/discord.ts), wrapped here so the runtime's
// grant-epoch lifecycle and fault→grant-state mapping (registry.ts) drive it.
// discord.js owns transient reconnect internally (auto-resumes dropped shards);
// only TERMINAL failures reach `fault`:
//   - login `TokenInvalid` / `DisallowedIntents`, or a live `invalidated`
//     session revocation → CredentialRejected{ grant: "bot" } → runtime renews
//     once, then degrades.
//   - any other terminal gateway/websocket failure → Disconnected → runtime
//     backs off and rebuilds.

import { DiscordjsError, DiscordjsErrorCodes } from "discord.js";
import { z } from "zod";
import type {
  ChatStopHandler,
  TalkActivity,
  TalkDirectory,
  TalkFeatureMap,
  TalkFeatureName,
  TalkHistory,
  TalkInboundMedia,
} from "@rome-os/app-runtime";
import { DiscordAdapter } from "../../channels/discord.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import type { ConversationSettingsService } from "../../conversation-settings/service.js";
import { SetupAbortError } from "../setup/session.js";
import type { SetupFn } from "../setup/types.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { tokenPaste } from "../schemes.js";
import type { ConnectionDescriptor, ProfileDisplay, ProfileRecord, Talker } from "../types.js";
import {
  directoryPage,
  historyQueryLimit,
  historyWindowHours,
  normalizedFromInbound,
  toInboundMessage,
  toMessageReceipt,
} from "./talk-features.js";

// The `bot` grant's profile — the identity the Discord API reports for the token
// (users/@me). Declared next to the material shape ({ token }); parse-then-store,
// and the same schema re-runs on revive (fail-closed). Both fields optional so a
// token whose users/@me identity was never captured stays sparse-but-valid.
export const discordGrantProfileSchema = z
  .object({
    /** Snowflake bot id (owner-side identity; not a display field). */
    botId: z.string().min(1).optional(),
    /** Bot username from users/@me — the bot's public identity. */
    botUsername: z.string().min(1).optional(),
  })
  .strict();
export type DiscordGrantProfile = z.infer<typeof discordGrantProfileSchema>;

/** Pure display projection: the bot username reads as the handle. `botId` stays
 *  owner-side and never widens the display surface. */
export function toDiscordDisplay(profile: DiscordGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: undefined,
    handle: profile.botUsername,
    email: undefined,
    avatarUrl: undefined,
  });
}

/** Revive a stored discord profile: re-parse with the schema, then map through
 *  the pure display function (fail-closed on a record that no longer matches). */
export function reviveDiscordProfile(record: ProfileRecord): ProfileDisplay {
  return toDiscordDisplay(discordGrantProfileSchema.parse(record));
}

/** The identity fields the discord settings row carries (users/@me output). */
export interface DiscordProfileSource {
  botId?: string;
  botUsername?: string;
}

/** Build the parsed grant profile from the settings row, or null when the row
 *  carries no identity to record (null / undefined / "" are the absent cases).
 *  Every other present value flows through untouched so the strict parse — not
 *  this picker — decides validity: a wrong-typed value fails loudly, never
 *  silently dropped or coerced. */
export function discordProfileFromSettings(
  settings: DiscordProfileSource,
): DiscordGrantProfile | null {
  const raw: Record<string, unknown> = {};
  if (settings.botId != null && settings.botId !== "") raw.botId = settings.botId;
  if (settings.botUsername != null && settings.botUsername !== "") {
    raw.botUsername = settings.botUsername;
  }
  if (Object.keys(raw).length === 0) return null;
  return discordGrantProfileSchema.parse(raw);
}

/**
 * True iff `err` is a Discord "credential refused" — a `DiscordjsError` whose
 * `code` is `TokenInvalid` or `DisallowedIntents`. These are the ONLY login
 * signals that map to grant state; every other gateway/transport
 * error is a `Disconnected`.
 */
export function isDiscordAuthError(err: unknown): boolean {
  return (
    err instanceof DiscordjsError &&
    (err.code === DiscordjsErrorCodes.TokenInvalid ||
      err.code === DiscordjsErrorCodes.DisallowedIntents)
  );
}

/**
 * Runtime deps the Discord adapter needs, threaded from index.ts at descriptor
 * registration time (the bridge/registry have no repo access). Mirrors what
 * ChannelManager.createAdapter passes today: the settings repo (channel config
 * read/write for slash commands) and the loaded-agent lister (agent-routing
 * validation + autocomplete).
 */
export interface DiscordDeps {
  conversationSettings: ConversationSettingsService;
  chatStop?: ChatStopHandler;
  personMappingRepo: PersonMappingRepository;
  listAgents: () => string[];
  /** Injectable token validator so the connect route / tests can drive the
   *  users/@me probe without hitting the network. Production pings the Discord
   *  REST API; a 401/!ok means the pasted token is not accepted. */
  validateToken?: (token: string) => Promise<void>;
  /** Injectable identity probe for the setup: validates the pasted
   *  token AND returns the bot's `users/@me` identity in one call. Production
   *  hits the Discord REST API (honoring the setup's abort signal so a cancel
   *  interrupts the in-flight probe); tests inject a fake. Throws (with a
   *  guardian-readable message) when the token is refused. */
  probeBotIdentity?: (
    token: string,
    signal?: AbortSignal,
  ) => Promise<{ botId: string; botUsername: string }>;
  /**
   * Injectable guardian-link probe for the setup. Opens a TEMPORARY
   * gateway on the PENDING (unconferred) token — never the real adapter — and
   * resolves with the id of the guardian who sends the one-time `code` back to
   * the bot, so the mapping lands in the same terminal write as the credential.
   * Must honor the abort signal (cancel interrupts the wait promptly).
   * Production uses a throwaway discord.js client; tests inject a fake.
   */
  waitForGuardianLink?: (
    token: string,
    code: string,
    signal: AbortSignal,
  ) => Promise<{ channelUserId: string }>;
  /** Injectable one-time guardian-link code generator (defaults to a random
   *  six-digit code); tests inject a fixed value. */
  generateVerificationCode?: () => string;
}

/** Default `users/@me` probe: a non-ok response means the token is refused. */
async function pingDiscordToken(token: string): Promise<void> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    throw new Error("Invalid bot token — check the Discord Developer Portal");
  }
}

/** Default identity probe: validate the token via `users/@me` and return the
 *  bot's id + username for the grant profile. */
async function pingDiscordIdentity(
  token: string,
  signal?: AbortSignal,
): Promise<{ botId: string; botUsername: string }> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
    signal,
  });
  if (!res.ok) {
    throw new Error("Invalid bot token — check the Discord Developer Portal");
  }
  const data = (await res.json()) as { id: string; username: string };
  return { botId: data.id, botUsername: data.username };
}

/**
 * Default guardian-link probe: a throwaway discord.js client logged in on the
 * pending token. It resolves with the author of the first non-bot message whose
 * text is the expiring one-time `code` shown in the dashboard — NOT merely the
 * first person to message the bot. Requiring the code closes the shared-guild
 * hole where any member could race the real guardian and win the guardian
 * mapping; a member who cannot see the dashboard code cannot forge the proof.
 * Non-matching messages are ignored and the wait continues. The client is
 * always destroyed, and the wait is cancellable via the abort signal (the setup
 * runtime also races the abort, so a hung gateway never wedges a cancel).
 */
/**
 * The guardian-link security gate: a message proves its sender is the guardian
 * ONLY when it comes from a non-bot author and its text is exactly the
 * one-time `code` shown in the dashboard. Extracted as a pure predicate so
 * the shared-guild race defense is unit-tested without a live gateway.
 */
export function isGuardianLinkMessage(
  msg: { author?: { bot?: boolean; id?: string }; content?: string },
  code: string,
): boolean {
  if (!msg.author || msg.author.bot) return false;
  return typeof msg.content === "string" && msg.content.trim() === code;
}

export async function waitForDiscordGuardianLink(
  token: string,
  code: string,
  signal: AbortSignal,
): Promise<{ channelUserId: string }> {
  const { Client, GatewayIntentBits, Partials } = await import("discord.js");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
  try {
    const channelUserId = await new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new SetupAbortError());
      const onAbort = (): void => reject(new SetupAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
      client.on("messageCreate", (msg) => {
        // Wrong-code / bot messages are ignored and the loop continues; only the
        // guardian's code-bearing message resolves.
        if (!isGuardianLinkMessage(msg, code)) return;
        signal.removeEventListener("abort", onAbort);
        resolve(msg.author.id);
      });
      client.login(token).catch(reject);
    });
    return { channelUserId };
  } finally {
    await client.destroy().catch(() => {});
  }
}

/** A random six-digit guardian-link code, matching the telegram/feishu pattern. */
function sixDigitCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Build the Discord conferral setup. A linear coroutine:
 *   1. prompt the bot token (re-prompt on a refused token, carrying the error),
 *   2. probe it (`users/@me`) for the bot identity,
 *   3. show the guardian-link instructions,
 *   4. `ctx.step` — wait for the guardian to message the bot (probe on the
 *      pending token), then
 *   5. return the terminal conferral: credential + profile + guardian mapping.
 * The runtime performs the single durable write from the returned conferral.
 */
export function makeDiscordSetup(deps: {
  probeBotIdentity: (
    token: string,
    signal?: AbortSignal,
  ) => Promise<{ botId: string; botUsername: string }>;
  waitForGuardianLink: (
    token: string,
    code: string,
    signal: AbortSignal,
  ) => Promise<{ channelUserId: string }>;
  /** Mints the one-time guardian-link code shown in the dashboard. */
  generateCode: () => string;
}): SetupFn {
  return async (interact, ctx) => {
    let error: string | undefined;
    let token: string;
    let identity: { botId: string; botUsername: string };
    for (;;) {
      ({ token } = await interact.prompt({
        instructions:
          "Create a Discord bot in the Developer Portal, invite it to your server, then paste its token below.",
        steps: [
          {
            text: "In the Developer Portal, click New Application, then add a bot from the Bot page if one is not created already.",
          },
          { text: "On the Bot page, click Reset Token to reveal your bot token." },
          {
            text: "On the same Bot page, enable Message Content Intent under Privileged Gateway Intents.",
          },
          {
            text: "Under OAuth2 → URL Generator, select the bot and applications.commands scopes and the View Channels, Send Messages, and Read Message History permissions, then open the generated URL to invite the bot to your server.",
          },
          { text: "Copy the bot token and paste it below." },
        ],
        links: [
          {
            label: "Open the Discord Developer Portal",
            url: "https://discord.com/developers/applications",
          },
        ],
        fields: [{ name: "token", label: "Discord bot token", secret: true }],
        note: 'Common issue — "View Channels" permission: after the bot joins, open the channel you want to use in Discord, go to Edit Channel → Permissions, find your bot (or its role), and make sure View Channel, Send Messages, and Read Message History are enabled. Admins who run Rome\'s slash commands also need permission to use application commands and manage channels.',
        ...(error ? { error } : {}),
      }));
      try {
        // Thread the setup's abort signal into the probe so a cancel interrupts
        // the in-flight validation fetch rather than waiting for it to return.
        identity = await deps.probeBotIdentity(token, ctx.signal);
        break;
      } catch (err) {
        // A cancel that aborted the probe must unwind the setup, not re-prompt.
        if (ctx.signal.aborted) throw err;
        error = err instanceof Error ? err.message : "Invalid bot token.";
      }
    }

    // Mint a one-time code the guardian must send to the bot. Binding is gated
    // on this proof (see waitForDiscordGuardianLink) so a shared-guild member
    // cannot race the guardian by simply messaging the bot first.
    const code = deps.generateCode();
    interact.show({
      title: "Link your account",
      body: [
        `Your bot @${identity.botUsername} is verified.`,
        "To finish linking your account as guardian, send this exact code to the bot in Discord:",
        code,
      ],
      steps: [{ text: `Send ${code} to your bot in Discord` }],
      progress: true,
    });

    const { channelUserId } = await ctx.step("discord-guardian-link", (signal) =>
      deps.waitForGuardianLink(token, code, signal),
    );

    const profile =
      discordProfileFromSettings({ botId: identity.botId, botUsername: identity.botUsername }) ??
      undefined;
    return {
      credential: { material: { token }, expiresAt: "never" },
      profile,
      guardianChannelUserId: channelUserId,
      summary: {
        title: "Discord connected",
        body: [`@${identity.botUsername} is live and your account is linked as guardian.`],
      },
    };
  };
}

/**
 * Build the Discord descriptor. `deps` carries the adapter's runtime
 * dependencies (settings repo, agent lister) so the wire stage can thread them
 * from index.ts where the repos exist.
 */
export function makeDiscordDescriptor(deps: DiscordDeps): ConnectionDescriptor {
  const validateToken = deps.validateToken ?? pingDiscordToken;
  const probeBotIdentity = deps.probeBotIdentity ?? pingDiscordIdentity;
  const waitForGuardianLink = deps.waitForGuardianLink ?? waitForDiscordGuardianLink;
  const generateCode = deps.generateVerificationCode ?? sixDigitCode;

  const botScheme = tokenPaste({
    label: "Discord bot token",
    instructions: "Paste the bot token from the Discord Developer Portal.",
    validate: validateToken,
  });
  // The Discord conferral setup: prompt the bot token, probe it,
  // present the guardian-link instructions, then wait (inside the setup, on
  // the PENDING token) for the guardian to message the bot before the single
  // terminal write of credential + profile + guardian mapping.
  botScheme.setup = makeDiscordSetup({ probeBotIdentity, waitForGuardianLink, generateCode });

  return {
    service: "discord",
    reviveProfile: (_grant, record) => reviveDiscordProfile(record),
    auth: {
      bot: botScheme,
    },
    capabilities: {
      talker: {
        needs: ["bot"] as const,
        build(creds, kit): Talker {
          const token = creds.bot.material as { token: string };
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;

          const adapter = new DiscordAdapter({
            botToken: token.token,
            connectionId: kit.connectionId,
            conversationSettings: deps.conversationSettings,
            chatStop: deps.chatStop,
            listAgents: deps.listAgents,
            isGuardian: async (channelUserId) =>
              (await deps.personMappingRepo.findByChannelUser("discord", channelUserId))
                ?.bondLevel === "guardian",
            // Live gateway faults (post-login) route through here; the descriptor
            // maps the adapter's kind onto grant state vs. transport.
            onGatewayFault: ({ kind, cause }) => {
              faultSink?.(
                kind === "credential"
                  ? new CredentialRejected({ grant: "bot", cause })
                  : new Disconnected(cause),
              );
            },
          });

          const routeStartFault = (err: unknown): void => {
            faultSink?.(
              isDiscordAuthError(err)
                ? new CredentialRejected({ grant: "bot", cause: err })
                : new Disconnected(err),
            );
          };

          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onMessage(async (msg) => deliver(toInboundMessage(msg)));
              // adapter.start() awaits client.login(), which rejects with a
              // DiscordjsError { code: TokenInvalid | DisallowedIntents } on a
              // refused token; the live gateway routes terminal errors through
              // onGatewayFault.
              adapter.start().catch(routeStartFault);
            },
            stop(): Promise<void> {
              return adapter.stop();
            },
            async send(conversationId, msg) {
              return toMessageReceipt(
                conversationId,
                await adapter.sendMessage(conversationId, conversationId, msg),
              );
            },
            feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
              const history: TalkHistory = {
                async query(input) {
                  const messages = await adapter.fetchHistory(
                    input.conversationId ?? null,
                    historyWindowHours(input.since),
                  );
                  return messages.slice(0, historyQueryLimit(input.limit)).map(toInboundMessage);
                },
              };
              const inboundMedia: TalkInboundMedia = {
                materialize: (message) =>
                  adapter.saveIncomingAttachments(normalizedFromInbound(message)),
              };
              const activity: TalkActivity = {
                async begin(input) {
                  await adapter.notifyTyping(input.conversationId);
                  return {
                    update: async () => adapter.notifyTyping(input.conversationId),
                    finish: async () => {},
                  };
                },
              };
              const directory: TalkDirectory = {
                async listConversations(input) {
                  const query = input.query?.toLocaleLowerCase();
                  const page = directoryPage(
                    adapter
                      .listGuildChannels()
                      .filter((channel) => input.includeTopics || channel.type !== "thread")
                      .filter(
                        (channel) =>
                          !query ||
                          `${channel.guildName} ${channel.name}`
                            .toLocaleLowerCase()
                            .includes(query),
                      )
                      .sort((left, right) =>
                        `${left.guildName}\0${left.name}\0${left.id}`.localeCompare(
                          `${right.guildName}\0${right.name}\0${right.id}`,
                        ),
                      ),
                    input,
                  );
                  return {
                    conversations: page.items.map((channel) => ({
                      ref: {
                        connectionId: kit.connectionId,
                        conversationId: channel.id as import("@rome-os/app-runtime").ConversationId,
                      },
                      service: "discord",
                      kind: channel.type === "thread" ? ("topic" as const) : ("channel" as const),
                      displayName: channel.name,
                      containerName: channel.guildName,
                      ...(channel.parentId
                        ? {
                            parent: {
                              connectionId: kit.connectionId,
                              conversationId:
                                channel.parentId as import("@rome-os/app-runtime").ConversationId,
                            },
                          }
                        : {}),
                    })),
                    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                  };
                },
              };
              const features: Partial<TalkFeatureMap> = {
                history,
                inboundMedia,
                activity,
                directory,
              };
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
          };
        },
      },
      actor: {
        needs: ["bot"] as const,
        build(creds) {
          const token = creds.bot.material as { token: string };
          const adapter = new DiscordAdapter({ botToken: token.token });
          return {
            operations: () => [
              {
                name: "discord.api.request",
                description: "Execute an authenticated Discord REST API request.",
                inputSchema: { type: "object" },
              },
            ],
            invoke(call) {
              if (call.operation !== "discord.api.request") {
                throw new Error(`Unknown Discord operation "${call.operation}"`);
              }
              return adapter
                .executeApiRequest(
                  call.input as import("../../channels/api-request.js").ChannelApiRequest,
                )
                .then((result) => {
                  if (result.response?.status === 401) {
                    throw new CredentialRejected({
                      grant: "bot",
                      cause: new Error("Discord REST API rejected the bot credential"),
                    });
                  }
                  return result;
                });
            },
            stop() {
              return adapter.stop();
            },
          };
        },
      },
    },
  };
}
