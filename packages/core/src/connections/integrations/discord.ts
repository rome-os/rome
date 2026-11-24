// Discord connection integration. Channel contract: docs/architecture/channels.md.
//
// Discord is a Talker with a single `bot` grant (a pasted bot token). The
// transport core — gateway lifecycle, the inbound `Message`, slash
// commands, send formatting — is `DiscordAdapter`
// (packages/core/src/connections/kinds/discord/discord.ts), wrapped here so the runtime's
// grant-epoch lifecycle and fault→grant-state mapping (registry.ts) drive it.
// The transport already speaks the channel's record, so inbound and send pass
// through without a projection. discord.js owns transient reconnect internally
// (auto-resumes dropped shards); only TERMINAL failures reach `fault`:
//   - login `TokenInvalid` / `DisallowedIntents`, or a live `invalidated`
//     session revocation → CredentialRejected{ grant: "bot" } → runtime renews
//     once, then degrades.
//   - any other terminal gateway/websocket failure → Disconnected → runtime
//     backs off and rebuilds.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChannelActivity, ChannelInboundMedia } from "@rome-os/app-runtime";
import type { TalkDirectory, TalkFeatures } from "../types.js";
import { DiscordAdapter, type GuildChannelInfo } from "../kinds/discord/discord.js";
import type { Commands } from "../command.js";
import type { SetupFn } from "../setup/types.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { tokenPaste } from "../schemes.js";
import type { ConnectionDescriptor, ProfileDisplay, ProfileRecord, Talker } from "../types.js";
import { directoryPage } from "./talk-features.js";
import { requireOnFirstUse } from "../../lib/require-on-first-use.js";
import type { ChatSettingsPort } from "../types.js";
import { DISCORD_CHAT_RULES } from "@rome/api-types/chat-rules";

const discordJs = requireOnFirstUse<typeof import("discord.js")>("discord.js");

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
    err instanceof discordJs().DiscordjsError &&
    (err.code === discordJs().DiscordjsErrorCodes.TokenInvalid ||
      err.code === discordJs().DiscordjsErrorCodes.DisallowedIntents)
  );
}

/** What the Discord descriptor is given at registration, threaded from
 *  index.ts where the services exist. */
export interface DiscordDeps {
  chatSettings: ChatSettingsPort;
  /** The commands a Connection's bot offers as slash commands. Absent, it
   *  offers none. */
  commandsOf?: (connectionId: string) => Commands;
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

export function makeDiscordSetup(deps: {
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

    const profile =
      discordProfileFromSettings({ botId: identity.botId, botUsername: identity.botUsername }) ??
      undefined;
    return {
      credential: { material: { token }, expiresAt: "never" },
      profile,
      summary: {
        title: "Discord connected",
        body: [
          `@${identity.botUsername} is live. Send it a private message, then approve your account in Settings → Connections or Activity.`,
        ],
      },
    };
  };
}

/** How many archived listings of one account may page at once. */
const SNAPSHOTS = 4;

/** A cursor into a snapshot of an archived listing: the snapshot's token,
 *  then the offset in it. Any other cursor names none. */
function snapshotCursor(cursor: string | undefined): { token: string; offset: string } | undefined {
  const dot = cursor?.indexOf(".") ?? -1;
  if (!cursor || dot < 0) return undefined;
  return { token: cursor.slice(0, dot), offset: cursor.slice(dot + 1) };
}

/**
 * Build the Discord descriptor. `deps` carries the adapter's runtime
 * dependencies (settings repo, agent lister) so the wire stage can thread them
 * from index.ts where the repos exist.
 */
export function makeDiscordDescriptor(deps: DiscordDeps): ConnectionDescriptor {
  const validateToken = deps.validateToken ?? pingDiscordToken;
  const probeBotIdentity = deps.probeBotIdentity ?? pingDiscordIdentity;

  const botScheme = tokenPaste({
    label: "Discord bot token",
    instructions: "Paste the bot token from the Discord Developer Portal.",
    validate: validateToken,
  });
  botScheme.setup = makeDiscordSetup({ probeBotIdentity });

  return {
    connectionKind: "discord",
    label: "Discord",
    severalAccounts: true,
    reviveProfile: (record) => reviveDiscordProfile(record),
    accountIdOf: (record) => (typeof record.botId === "string" && record.botId) || null,
    link: "own_account",
    grant: "bot",
    chatRules: DISCORD_CHAT_RULES,
    auth: botScheme,
    capabilities: {
      talker: {
        reads: true,
        build(cred, kit): Talker {
          const token = cred.material as { token: string };
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;

          const adapter = new DiscordAdapter({
            botToken: token.token,
            connectionId: kit.connectionId,
            chatSettings: deps.chatSettings,
            ...(deps.commandsOf ? { commands: deps.commandsOf(kit.connectionId) } : {}),
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

          const inboundMedia: ChannelInboundMedia = {
            materialize: (message) => adapter.saveIncomingAttachments(message),
          };
          const activity: ChannelActivity = {
            async begin(input) {
              await adapter.notifyTyping(input.chatId);
              return {
                update: async () => adapter.notifyTyping(input.chatId),
                finish: async () => {},
              };
            },
          };
          // A listing of archived threads reads every archive from Discord,
          // so later pages read the first page's snapshot instead of reading
          // the archives again, which would also shift offsets between reads.
          // A few listings may run at once; the oldest is dropped past that.
          const snapshots = new Map<string, GuildChannelInfo[]>();
          const listed = async (
            input: Parameters<TalkDirectory["listConversations"]>[0],
          ): Promise<GuildChannelInfo[]> => {
            const query = input.query?.toLocaleLowerCase();
            // The gateway keeps a thread it saw archived; one is listed only
            // when archived threads are asked for.
            const active = adapter
              .listGuildChannels()
              .filter((channel) => input.includeArchived || !channel.archived)
              // The gateway also names chats the bot may not see.
              .filter((channel) => adapter.sees(channel));
            const named = new Set(active.map((channel) => channel.id));
            // Archived threads are read from Discord; the gateway names the
            // ones it has seen. A thread both name is listed once.
            const archived = input.includeArchived
              ? (await adapter.listArchivedThreads()).filter((thread) => !named.has(thread.id))
              : [];
            const threads = input.includeTopics || input.includeArchived;
            return [...active, ...archived]
              .filter((channel) => threads || channel.type !== "thread")
              .filter(
                (channel) =>
                  !query ||
                  `${channel.guildName} ${channel.name}`.toLocaleLowerCase().includes(query),
              )
              .sort((left, right) =>
                `${left.guildName}\0${left.name}\0${left.id}`.localeCompare(
                  `${right.guildName}\0${right.name}\0${right.id}`,
                ),
              );
          };
          const directory: TalkDirectory = {
            async listConversations(input) {
              // Before the gateway logs in it names no chats, which is no
              // listing of them.
              if (!adapter.isReady()) {
                throw new Error("Discord is not connected yet; list its chats again shortly");
              }
              const resumed = input.includeArchived ? snapshotCursor(input.cursor) : undefined;
              const kept = resumed ? snapshots.get(resumed.token) : undefined;
              if (resumed && !kept) {
                throw new Error("This Discord listing has expired; list its chats from the start");
              }
              const items = kept ?? (await listed(input));
              const cursor = resumed ? resumed.offset : input.cursor;
              const page = directoryPage(items, { ...input, ...(cursor ? { cursor } : {}) });
              let nextCursor = page.nextCursor;
              if (input.includeArchived) {
                const token = resumed?.token ?? randomUUID();
                if (!nextCursor) snapshots.delete(token);
                else {
                  if (!resumed) {
                    snapshots.set(token, items);
                    const oldest = snapshots.keys().next().value;
                    if (snapshots.size > SNAPSHOTS && oldest) snapshots.delete(oldest);
                  }
                  nextCursor = `${token}.${nextCursor}`;
                }
              }
              return {
                conversations: page.items.map((channel) => ({
                  ref: {
                    connectionId: kit.connectionId,
                    chatId: channel.id as import("@rome-os/app-runtime").ChatId,
                  },
                  connectionKind: "discord",
                  service: "discord",
                  kind: channel.type === "thread" ? ("topic" as const) : ("channel" as const),
                  displayName: channel.name,
                  containerName: channel.guildName,
                  ...(channel.archived ? { archived: true } : {}),
                  // Discord also uses parentId for a channel's category.
                  // Only native threads inherit conversation settings.
                  ...(channel.type === "thread" && channel.parentId
                    ? {
                        parent: {
                          connectionId: kit.connectionId,
                          chatId: channel.parentId as import("@rome-os/app-runtime").ChatId,
                        },
                      }
                    : {}),
                })),
                ...(nextCursor ? { nextCursor } : {}),
              };
            },
          };
          const features: TalkFeatures = {
            directMessaging: {
              chatFor: async (userId) =>
                (await adapter.directConversationFor(
                  userId,
                )) as import("@rome-os/app-runtime").ChatId,
            },
            inboundMedia,
            activity,
            directory,
            history: { read: (chatId, read) => adapter.readHistory(chatId, read) },
          };
          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onInbound(async (msg) => deliver(msg));
              // adapter.start() awaits client.login(), which rejects with a
              // DiscordjsError { code: TokenInvalid | DisallowedIntents } on a
              // refused token; the live gateway routes terminal errors through
              // onGatewayFault.
              adapter.start().catch(routeStartFault);
            },
            stop(): Promise<void> {
              return adapter.stop();
            },
            send(chatId, msg) {
              return adapter.send(chatId, msg);
            },
            ...features,
          };
        },
      },
      actor: {
        build(cred) {
          const token = cred.material as { token: string };
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
                  call.input as import("../../apps/platform-requests.js").ConnectionApiRequest,
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
