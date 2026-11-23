// Rome's own Discord bot connection. Channel contract:
// docs/architecture/channels.md.

import { z } from "zod";
import { createLogger } from "../../../logger.js";
import { CredentialRejected } from "../../errors.js";
import type { SetupFn } from "../../setup/types.js";
import type {
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  SecretRecord,
  Talker,
} from "../../types.js";
import { DiscordAppAdapter } from "./adapter.js";
import { type DiscordAppCloud, DiscordAppRefused, isDiscordAppCredentialError } from "./worker.js";

const log = createLogger("discord-app");

export const DISCORD_APP_KIND = "discord_app";

/** The grant's profile: the bot, as the Worker names it. */
const discordAppGrantProfileSchema = z
  .object({
    botId: z.string().min(1),
    botUsername: z.string().min(1),
  })
  .strict();
type DiscordAppGrantProfile = z.infer<typeof discordAppGrantProfileSchema>;

/** The grant's material: the key the Worker signs this instance's deposits
 *  with, and the bot it answers as, kept beside it for the transport. */
interface DiscordAppMaterial extends SecretRecord {
  depositKey: string;
  botId: string;
  botUsername: string;
}

function materialOf(material: unknown): DiscordAppMaterial {
  const record = material as Partial<DiscordAppMaterial> | null;
  if (
    typeof record?.depositKey !== "string" ||
    !record.depositKey ||
    typeof record.botId !== "string"
  ) {
    throw new Error("The Discord grant is missing its key.");
  }
  return {
    depositKey: record.depositKey,
    botId: record.botId,
    botUsername:
      typeof record.botUsername === "string" && record.botUsername ? record.botUsername : "Rome",
  };
}

function toDiscordAppDisplay(profile: DiscordAppGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.botUsername,
    handle: undefined,
    email: undefined,
    avatarUrl: undefined,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DiscordAppDescriptorDeps {
  cloud: DiscordAppCloud;
  /** The public address of this instance's relay mailbox, or null while Rome
   *  Cloud has not given one. Read on each connect. */
  depositUrl: () => Promise<string | null>;
  /** A Discord account's name as People knows it, for the card. */
  nameOf: (userId: string) => Promise<string | undefined>;
}

/** Connect, with no form: the Worker starts depositing into this instance's
 *  mailbox. The card then offers Add to server. */
export function makeDiscordAppSetup(deps: DiscordAppDescriptorDeps): SetupFn {
  return async (_interact, ctx) => {
    const depositUrl = await deps.depositUrl();
    if (!depositUrl)
      throw new Error("Rome can't receive Discord messages yet. Try again in a minute.");
    let connected: Awaited<ReturnType<DiscordAppCloud["connect"]>>;
    try {
      connected = await ctx.step("discord-app-connect", () =>
        deps.cloud.connect(depositUrl, ctx.signal),
      );
    } catch (error) {
      if (error instanceof DiscordAppRefused) throw new Error(error.message);
      throw error;
    }
    return {
      credential: {
        material: {
          depositKey: connected.depositKey,
          botId: connected.botId,
          botUsername: connected.botUsername,
        } satisfies DiscordAppMaterial,
        expiresAt: "never",
      },
      profile: discordAppGrantProfileSchema.parse({
        botId: connected.botId,
        botUsername: connected.botUsername,
      }),
      summary: {
        title: "Discord connected",
        body: ["Add Rome to a server you manage, then message it there or in a direct message."],
      },
    };
  };
}

/** Access comes through the setup only. A refused token needs the setup again. */
function discordAppScheme(): AuthScheme {
  return {
    async obtain(): Promise<Credential> {
      throw new Error(
        "Rome's Discord bot is connected through its setup, not a headless obtain().",
      );
    },
    async renew() {
      return "needs-fix";
    },
  };
}

export function createDiscordAppDescriptor(deps: DiscordAppDescriptorDeps): ConnectionDescriptor {
  const scheme = discordAppScheme();
  scheme.setup = makeDiscordAppSetup(deps);
  return {
    connectionKind: DISCORD_APP_KIND,
    label: "Discord",
    reviveProfile: (record) => toDiscordAppDisplay(discordAppGrantProfileSchema.parse(record)),
    accountIdOf: (record: ProfileRecord) =>
      typeof record.botId === "string" && record.botId ? record.botId : null,
    link: "own_account",
    // It answers as the guardian's Concierge from the first message, like
    // Rome's Slack app (docs/adrs/channels-and-connectors-are-one-connection.md).
    startsWithConcierge: true,
    // An official app offers no chat rules: every chat runs at the defaults.
    chatRules: { offers: [] },
    grant: "bot",
    auth: scheme,
    // Every binding of this instance goes at the Worker, and the bot leaves
    // servers no other Rome uses.
    async onDisconnect(_grant, { signal }) {
      try {
        await deps.cloud.disconnect(signal);
      } catch (error) {
        throw new Error(`Discord's service did not let go of this Rome (${describe(error)})`);
      }
    },
    capabilities: {
      talker: {
        build(cred, kit): Talker {
          let { depositKey, botId, botUsername } = materialOf(cred.material);
          let adapter = makeAdapter();
          let unregister: (() => void) | null = null;
          let fault: ((err: CredentialRejected) => void) | null = null;

          function makeAdapter() {
            return new DiscordAppAdapter({
              botId,
              botUsername,
              depositKey,
              cloud: deps.cloud,
            });
          }

          // Each start tells the Worker where this instance's mailbox is now.
          // The Worker keeps the key across connects, and makes a new one only
          // after it forgot this instance (a disconnect, or its daily check),
          // which the grant then keeps. A failure keeps the stored key, which
          // still checks what the mailbox holds.
          const refresh = async (deliver: Parameters<Talker["start"]>[0]) => {
            const depositUrl = await deps.depositUrl();
            if (!depositUrl) return;
            try {
              const connected = await deps.cloud.connect(depositUrl);
              if (connected.depositKey === depositKey && connected.botId === botId) return;
              await kit.persist({
                depositKey: connected.depositKey,
                botId: connected.botId,
                botUsername: connected.botUsername,
              } satisfies DiscordAppMaterial);
              depositKey = connected.depositKey;
              botId = connected.botId;
              botUsername = connected.botUsername;
              adapter.stop();
              adapter = makeAdapter();
              adapter.start(deliver);
            } catch (error) {
              if (isDiscordAppCredentialError(error)) {
                fault?.(new CredentialRejected({ grant: "bot", cause: error }));
                return;
              }
              log.warn("discord connect on start failed; keeping the stored key", {
                error: describe(error),
              });
            }
          };

          return {
            start(deliver, onFault): void {
              fault = onFault;
              adapter.start(deliver);
              unregister = kit.registerIngress(async (input) => {
                const frame = input as { body?: unknown; signature?: unknown };
                const body = frame.body instanceof Uint8Array ? frame.body : new Uint8Array(0);
                const signature = typeof frame.signature === "string" ? frame.signature : "";
                return adapter.ingest(body, signature);
              });
              void refresh(deliver);
            },
            stop() {
              unregister?.();
              unregister = null;
              adapter.stop();
            },
            // Shown while a message is being written, by the dashboard's rule
            // for its typing dots (core/connection-typing.ts).
            typing: { show: (chatId) => adapter.showTyping(chatId) },
            reactions: {
              add: (chatId, messageId, emoji) => adapter.react(chatId, messageId, emoji),
              remove: (chatId, messageId, emoji) => adapter.unreact(chatId, messageId, emoji),
            },
            async send(chatId, message) {
              try {
                return await adapter.send(chatId, message);
              } catch (error) {
                if (isDiscordAppCredentialError(error)) {
                  throw new CredentialRejected({ grant: "bot", cause: error });
                }
                throw error;
              }
            },
          };
        },
      },
    },
  };
}
