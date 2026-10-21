// Slack bot connection integration. Channel contract: docs/architecture/channels.md.
//
// A Slack bot is one of Rome's accounts with one agent, and each bot is its
// own Slack app: Slack gives an app exactly one bot per workspace, so two
// agents in one workspace are two apps. The guardian creates the app from a
// prefilled manifest link, installs it, and pastes its two tokens back. Rome
// never creates or configures Slack apps itself, so it holds no configuration
// token. The transport is `SlackAdapter` (packages/core/src/channels/slack.ts),
// which opens its own Socket Mode connection. Only TERMINAL failures reach
// `fault`:
//   - a refused bot or app-level token, an uninstalled app, or revoked tokens
//     → CredentialRejected{ grant: "bot" } → runtime renews once, then degrades.
//   - a Socket Mode connection that keeps failing to reopen → Disconnected →
//     runtime backs off and rebuilds.
//
// This service is separate from `slack`, the Rome Cloud-brokered OAuth
// connection that acts in a workspace for the guardian.

import { z } from "zod";
import {
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SlackAdapter,
  type CreateSlackSocket,
  type SlackBotIdentity,
  type SlackWebApi,
  isSlackCredentialError,
  slackWebApi,
} from "../../channels/slack.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { credentialsPaste } from "../schemes.js";
import type { SetupFn } from "../setup/types.js";
import type { ConnectionDescriptor, ProfileDisplay, ProfileRecord, Talker } from "../types.js";

export const SLACK_BOT_SERVICE = "slack_bot";

/** Slack caps an app's name at 35 characters. */
const SLACK_APP_NAME_MAX = 35;

// The `bot` grant's profile: the identity auth.test reports for the bot token.
// Parse-then-store, and the same schema re-runs on revive (fail-closed).
export const slackBotGrantProfileSchema = z
  .object({
    teamId: z.string().min(1),
    workspaceName: z.string().min(1).optional(),
    botUserId: z.string().min(1),
    botUsername: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
  })
  .strict();
export type SlackBotGrantProfile = z.infer<typeof slackBotGrantProfileSchema>;

/** The bot's handle reads as the handle and the workspace as its name. Slack
 *  ids stay owner-side and never widen the display surface. */
export function toSlackBotDisplay(profile: SlackBotGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.workspaceName,
    handle: profile.botUsername ? `@${profile.botUsername}` : undefined,
    email: undefined,
    avatarUrl: undefined,
  });
}

export function reviveSlackBotProfile(record: ProfileRecord): ProfileDisplay {
  return toSlackBotDisplay(slackBotGrantProfileSchema.parse(record));
}

/** A bot is named by its workspace and its bot user, since Slack issues user
 *  ids per workspace. */
export function slackBotAccountId(record: ProfileRecord): string | null {
  const { teamId, botUserId } = record;
  return typeof teamId === "string" && teamId && typeof botUserId === "string" && botUserId
    ? `${teamId}/${botUserId}`
    : null;
}

/** Slack's bot display name takes lowercase letters, digits, `.`, `-` and
 *  `_` only. */
export function slackBotDisplayName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "rome").slice(0, 80);
}

/**
 * The manifest of one Rome Slack app. Socket Mode is on, so the app needs no
 * request URL. A manifest carries no icon: the guardian uploads the agent's
 * picture on the app's settings page.
 */
export function slackBotManifest(name: string): Record<string, unknown> {
  return {
    display_information: {
      name,
      description: `${name}, an agent on Rome.`,
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: slackBotDisplayName(name), always_online: true },
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** The link that opens Slack's "create app" flow with the manifest filled in.
 *  The guardian still picks the workspace and confirms. */
export function slackCreateAppUrl(name: string): string {
  const manifest = encodeURIComponent(JSON.stringify(slackBotManifest(name)));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${manifest}`;
}

export interface SlackBotDescriptorDeps {
  /** Injectable Slack Web API so tests drive the setup and the transport
   *  without the network. */
  api?: SlackWebApi;
  createSocket?: CreateSlackSocket;
}

/** Checks both pasted tokens and answers the bot's identity. Throws a
 *  guardian-readable message when Slack refuses either. */
async function probeSlackBot(
  api: SlackWebApi,
  material: { botToken: string; appToken: string },
  signal?: AbortSignal,
): Promise<SlackBotGrantProfile> {
  if (!material.botToken.startsWith("xoxb-")) {
    throw new Error("The bot token starts with xoxb-. Copy it from OAuth & Permissions.");
  }
  if (!material.appToken.startsWith("xapp-")) {
    throw new Error("The app-level token starts with xapp-. Generate it under Basic Information.");
  }
  let identity: SlackBotIdentity;
  try {
    identity = await api.authTest(material.botToken, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Slack did not accept the bot token. Install the app, then copy it again.");
  }
  try {
    // Opening a connection proves the app-level token has connections:write
    // and that Socket Mode is on. The URL is single-use, so it is dropped.
    await api.openConnection(material.appToken, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      "Slack did not accept the app-level token. Generate one with the connections:write scope and check that Socket Mode is on.",
    );
  }
  return slackBotGrantProfileSchema.parse({
    teamId: identity.teamId,
    botUserId: identity.botUserId,
    ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}),
    ...(identity.botUsername ? { botUsername: identity.botUsername } : {}),
    ...(identity.appId ? { appId: identity.appId } : {}),
  });
}

export function makeSlackBotSetup(deps: { api: SlackWebApi }): SetupFn {
  return async (interact, ctx) => {
    let error: string | undefined;
    let name: string;
    for (;;) {
      ({ name } = await interact.prompt({
        instructions:
          "Each Slack bot is its own Slack app. Name the bot the way people in your workspace should see it, usually after the agent that answers as it.",
        fields: [{ name: "name", label: "Bot name", secret: false }],
        ...(error ? { error } : {}),
      }));
      name = name.trim();
      if (name && name.length <= SLACK_APP_NAME_MAX) break;
      error = name
        ? `Slack app names are at most ${SLACK_APP_NAME_MAX} characters.`
        : "Enter a name for the bot.";
    }

    error = undefined;
    let material: { botToken: string; appToken: string };
    let profile: SlackBotGrantProfile;
    for (;;) {
      const answers = await interact.prompt({
        instructions: `Create the ${name} app in Slack from the link below, install it to your workspace, then paste its two tokens.`,
        steps: [
          {
            text: "Open the link, pick the workspace, and click Next, then Create. The name, permissions, events and Socket Mode are already filled in.",
          },
          {
            text: "On the app's Install App page, click Install to Workspace and allow it.",
          },
          {
            text: "On Basic Information, under App-Level Tokens, click Generate Token and Scopes, add the connections:write scope, and copy the token that starts with xapp-.",
          },
          {
            text: "On OAuth & Permissions, copy the Bot User OAuth Token that starts with xoxb-.",
          },
          {
            text: "Optional: upload the agent's picture under Display Information on Basic Information. Slack does not take a picture through the link.",
          },
        ],
        links: [{ label: `Create ${name} in Slack`, url: slackCreateAppUrl(name) }],
        fields: [
          { name: "botToken", label: "Bot User OAuth Token (xoxb-)", secret: true },
          { name: "appToken", label: "App-Level Token (xapp-)", secret: true },
        ],
        note: "A free Slack workspace allows ten apps in total, so each agent's bot counts toward that limit.",
        ...(error ? { error } : {}),
      });
      material = {
        botToken: (answers.botToken ?? "").trim(),
        appToken: (answers.appToken ?? "").trim(),
      };
      try {
        profile = await ctx.step("slack-bot-identity", (signal) =>
          probeSlackBot(deps.api, material, signal),
        );
        break;
      } catch (err) {
        // A cancel that aborted the probe must unwind the setup, not re-prompt.
        if (ctx.signal.aborted) throw err;
        error = err instanceof Error ? err.message : "Slack did not accept the tokens.";
      }
    }

    const handle = profile.botUsername ? `@${profile.botUsername}` : name;
    return {
      credential: { material, expiresAt: "never" },
      profile,
      summary: {
        title: "Slack connected",
        body: [
          `${handle} is live in ${profile.workspaceName ?? "your workspace"}. Send it a direct message, then approve your account in Settings → Connections or Activity. Invite it to a channel and mention it to talk there.`,
        ],
      },
    };
  };
}

function botMaterial(material: unknown): { botToken: string; appToken: string } {
  const record = material as { botToken?: unknown; appToken?: unknown };
  if (typeof record.botToken !== "string" || typeof record.appToken !== "string") {
    throw new Error("The Slack bot grant holds no bot and app-level tokens.");
  }
  return { botToken: record.botToken, appToken: record.appToken };
}

export function makeSlackBotDescriptor(deps: SlackBotDescriptorDeps = {}): ConnectionDescriptor {
  const api = deps.api ?? slackWebApi;
  const botScheme = credentialsPaste({
    instructions: "Paste the Slack app's bot token and app-level token.",
    fields: [
      { name: "botToken", label: "Bot User OAuth Token (xoxb-)" },
      { name: "appToken", label: "App-Level Token (xapp-)" },
    ],
    validate: async (material) => {
      await probeSlackBot(api, botMaterial(material));
    },
  });
  botScheme.setup = makeSlackBotSetup({ api });

  return {
    service: SLACK_BOT_SERVICE,
    severalAccounts: true,
    reviveProfile: (_grant, record) => reviveSlackBotProfile(record),
    accountIdOf: (_grant, record) => slackBotAccountId(record),
    auth: { bot: botScheme },
    capabilities: {
      talker: {
        needs: ["bot"] as const,
        build(creds): Talker {
          const material = botMaterial(creds.bot.material);
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          const routeFault = (cause: unknown): void => {
            faultSink?.(
              isSlackCredentialError(cause)
                ? new CredentialRejected({ grant: "bot", cause })
                : new Disconnected(cause),
            );
          };
          const adapter = new SlackAdapter({
            botToken: material.botToken,
            appToken: material.appToken,
            channel: SLACK_BOT_SERVICE,
            api,
            createSocket: deps.createSocket,
            onFault: ({ kind, cause }) =>
              faultSink?.(
                kind === "credential"
                  ? new CredentialRejected({ grant: "bot", cause })
                  : new Disconnected(cause),
              ),
          });
          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onInbound(async (message) => deliver(message));
              adapter.start().catch(routeFault);
            },
            stop(): void {
              adapter.stop();
            },
            async send(conversationId, message) {
              try {
                return await adapter.send(conversationId, message);
              } catch (error) {
                if (isSlackCredentialError(error)) {
                  throw new CredentialRejected({ grant: "bot", cause: error });
                }
                throw error;
              }
            },
            // A Slack direct message is its own conversation, opened with
            // conversations.open, so this is a provider call.
            directMessaging: {
              conversationFor: (senderId) => adapter.directConversationFor(senderId),
            },
          };
        },
      },
    },
  };
}
