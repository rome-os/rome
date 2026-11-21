// Rome's own Slack app connection. Channel contract: docs/architecture/channels.md.
//
// The guardian adds Rome to their Slack workspace in one sign-in: Connect,
// Slack's approve screen, done. Nothing is pasted and no Slack app is made by
// the guardian. The connection's account is the app's bot in that workspace,
// named by team id and bot user id as the Slack bot kind names its bots. It
// takes an agent like any bot, and a new one starts with the Concierge.
//
// Rome Cloud holds the app's secrets, runs the exchange with Slack, and binds
// the workspace to this instance (one workspace, one instance). The instance
// holds the bot token, drains the workspace's relay mailbox for its events
// (`kinds/slack-app/slack-app.ts`) and replies through Slack's Web API.
//
// This kind is separate from `slack_bot` (a Slack app the guardian makes) and
// `slack` (Rome Cloud OAuth that acts for the guardian). Both keep working.

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getInstanceOrigin } from "../../instance/rome-cloud-origin.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { isSlackCredentialError } from "../kinds/slack/slack.js";
import type { SlackAppCloud, SlackAppInstall } from "../kinds/slack-app/rome-cloud.js";
import { SlackAppRefused } from "../kinds/slack-app/rome-cloud.js";
import {
  type OpenMailbox,
  SlackAppAdapter,
  type SlackMessageCopy,
} from "../kinds/slack-app/slack-app.js";
import type { SlackAppWebApi } from "../kinds/slack-app/web-api.js";
import type { SetupFn } from "../setup/types.js";
import type {
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  SecretRecord,
  Talker,
} from "../types.js";

export const SLACK_APP_KIND = "slack_app";

/** The grant's profile: the bot in one workspace, and who added it. */
export const slackAppGrantProfileSchema = z
  .object({
    teamId: z.string().min(1),
    workspaceName: z.string().min(1).optional(),
    botUserId: z.string().min(1),
    appId: z.string().min(1).optional(),
    /** The workspace member who approved the app: the guardian there. */
    installerUserId: z.string().min(1).optional(),
  })
  .strict();
export type SlackAppGrantProfile = z.infer<typeof slackAppGrantProfileSchema>;

/** The grant's material: the bot token, and how the workspace's events reach
 *  this instance. */
export interface SlackAppMaterial extends SecretRecord {
  /** The workspace and bot the token answers as, kept beside it so the
   *  transport can check every event against them. */
  teamId: string;
  botUserId: string;
  botToken: string;
  forwardSecret: string;
  connectUrl: string;
  drainKey: string;
}

export function toSlackAppDisplay(profile: SlackAppGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.workspaceName ? `Rome (${profile.workspaceName})` : "Rome",
    handle: undefined,
    email: undefined,
    avatarUrl: undefined,
  });
}

/** The bot is named by its workspace and its bot user, as the Slack bot kind
 *  names one, since Slack issues user ids per workspace. */
export function slackAppAccountId(record: ProfileRecord): string | null {
  const { teamId, botUserId } = record;
  return typeof teamId === "string" && teamId && typeof botUserId === "string" && botUserId
    ? `${teamId}/${botUserId}`
    : null;
}

function materialOf(material: unknown): SlackAppMaterial {
  const record = material as Partial<SlackAppMaterial> | null;
  if (
    typeof record?.teamId !== "string" ||
    typeof record.botUserId !== "string" ||
    typeof record.botToken !== "string" ||
    typeof record.forwardSecret !== "string" ||
    typeof record.connectUrl !== "string" ||
    typeof record.drainKey !== "string"
  ) {
    throw new Error("The Slack app grant is missing its token or mailbox.");
  }
  return {
    teamId: record.teamId,
    botUserId: record.botUserId,
    botToken: record.botToken,
    forwardSecret: record.forwardSecret,
    connectUrl: record.connectUrl,
    drainKey: record.drainKey,
  };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** What a refusal on the way back from Slack means, for the guardian. */
function returnError(code: string): string {
  switch (code) {
    case "access_denied":
      return "Slack was not added. Press Connect again when you are ready.";
    case "enterprise_install":
      return "Rome can be added to one Slack workspace at a time, not a whole Enterprise Grid organization.";
    default:
      return `Slack did not finish adding Rome (${code}). Press Connect to try again.`;
  }
}

export interface SlackAppSetupDeps {
  cloud: SlackAppCloud;
  /** The instance's own origin, where the guardian's browser returns. */
  instanceOrigin?: () => string;
}

/**
 * Connect, as one coroutine: ask Rome Cloud for Slack's approve screen, send
 * the guardian there, and redeem what comes back. No form. The member who
 * approved is mapped as the guardian on this connection, so their direct
 * messages are the guardian's from the first one.
 */
export function makeSlackAppSetup(deps: SlackAppSetupDeps): SetupFn {
  return async (interact, ctx) => {
    const state = base64Url(randomBytes(24));
    const codeVerifier = base64Url(randomBytes(48));
    const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
    const authorizeUrl = await ctx.step("slack-app-start", () =>
      deps.cloud.start({
        callbackOrigin: (deps.instanceOrigin ?? getInstanceOrigin)(),
        state,
        codeChallenge,
      }),
    );
    const returned = await interact.redirect(authorizeUrl);
    if (typeof returned.error === "string" && returned.error) {
      throw new Error(returnError(returned.error));
    }
    const handoff = typeof returned.handoff === "string" ? returned.handoff.trim() : "";
    if (!handoff) throw new Error("Slack's answer did not come back. Press Connect to try again.");

    interact.show({ body: ["Finishing adding Rome to Slack…"], progress: true });
    let install: SlackAppInstall;
    try {
      install = await ctx.step("slack-app-redeem", () =>
        deps.cloud.redeem({ handoff, codeVerifier }),
      );
    } catch (error) {
      // Rome Cloud's refusal, such as a workspace another Rome holds, is
      // written for the guardian.
      if (error instanceof SlackAppRefused) throw new Error(error.message);
      throw error;
    }

    const profile = slackAppGrantProfileSchema.parse({
      teamId: install.teamId,
      botUserId: install.botUserId,
      ...(install.teamName ? { workspaceName: install.teamName } : {}),
      ...(install.appId ? { appId: install.appId } : {}),
      ...(install.installerUserId ? { installerUserId: install.installerUserId } : {}),
    });
    const material: SlackAppMaterial = {
      teamId: install.teamId,
      botUserId: install.botUserId,
      botToken: install.botToken,
      forwardSecret: install.forwardSecret,
      connectUrl: install.mailbox.connectUrl,
      drainKey: install.mailbox.drainKey,
    };
    const workspace = install.teamName ?? "your workspace";
    return {
      credential: { material, expiresAt: "never" },
      profile,
      ...(install.installerUserId
        ? {
            guardianChannelUserId: `${install.teamId}/${install.installerUserId}`,
            addsGuardianAccount: true,
          }
        : {}),
      summary: {
        title: "Slack connected",
        body: [`Rome is in ${workspace}. Send it a direct message in Slack.`],
      },
    };
  };
}

/** Give access through the setup only. Without the guardian the grant cannot
 *  be renewed: a refused token needs the same sign-in again. */
function slackAppScheme(): AuthScheme {
  return {
    async obtain(): Promise<Credential> {
      throw new Error("Rome's Slack app is connected through its setup, not a headless obtain().");
    },
    async renew() {
      return "needs-fix";
    },
  };
}

export interface SlackAppDescriptorDeps {
  api: SlackAppWebApi;
  cloud: SlackAppCloud;
  openMailbox: OpenMailbox;
  /** The connection's own copy of the direct messages it hears. */
  copy: SlackMessageCopy;
  /** Whether Rome listens to the account behind a connection. */
  listens: (connectionId: string) => boolean;
  instanceOrigin?: () => string;
}

export function makeSlackAppDescriptor(deps: SlackAppDescriptorDeps): ConnectionDescriptor {
  const scheme = slackAppScheme();
  scheme.setup = makeSlackAppSetup({ cloud: deps.cloud, instanceOrigin: deps.instanceOrigin });
  return {
    connectionKind: SLACK_APP_KIND,
    label: "Slack",
    // Phase 1 connects one workspace. Adding another goes through a redirect
    // that returns to Settings, which cannot yet follow a second setup.
    reviveProfile: (record) => toSlackAppDisplay(slackAppGrantProfileSchema.parse(record)),
    accountIdOf: (record) => slackAppAccountId(record),
    link: "own_account",
    // A new workspace answers as the guardian's Concierge from its first
    // message (docs/adrs/channels-and-connectors-are-one-connection.md).
    startsWithConcierge: true,
    // An official app offers no chat rules: every chat runs at the defaults.
    chatRules: { offers: [] },
    grant: "bot",
    auth: scheme,
    capabilities: {
      talker: {
        build(cred, kit): Talker {
          const material = materialOf(cred.material);
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          const routeFault = (cause: unknown, kind?: "credential" | "transport"): void => {
            const credential = kind ? kind === "credential" : isSlackCredentialError(cause);
            faultSink?.(
              credential
                ? new CredentialRejected({ grant: "bot", cause })
                : new Disconnected(cause),
            );
          };
          const adapter = new SlackAppAdapter({
            channel: SLACK_APP_KIND,
            botToken: material.botToken,
            teamId: material.teamId,
            botUserId: material.botUserId,
            forwardSecret: material.forwardSecret,
            mailbox: { connectUrl: material.connectUrl, drainKey: material.drainKey },
            api: deps.api,
            openMailbox: deps.openMailbox,
            refreshMailbox: () => deps.cloud.refreshMailbox(material.teamId),
            // The drain key expires; keep the fresh one with the grant so a
            // restart while Rome Cloud is away still drains. A failed write
            // keeps the adapter on the stored key, which the relay still takes.
            onMailboxRefreshed: (mailbox) => kit.persist({ ...material, ...mailbox }),
            onFault: ({ kind, cause }) => routeFault(cause, kind),
            copy: deps.copy,
            listened: () => deps.listens(kit.connectionId),
          });
          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onInbound(deliver);
              adapter.start().catch((cause) => routeFault(cause));
            },
            stop() {
              return adapter.stop();
            },
            async send(chatId, message) {
              try {
                return await adapter.send(chatId, message);
              } catch (error) {
                if (isSlackCredentialError(error)) {
                  throw new CredentialRejected({ grant: "bot", cause: error });
                }
                throw error;
              }
            },
            directMessaging: {
              async chatFor(senderId) {
                try {
                  return await adapter.directConversationFor(senderId);
                } catch (error) {
                  if (isSlackCredentialError(error)) {
                    throw new CredentialRejected({ grant: "bot", cause: error });
                  }
                  throw error;
                }
              },
            },
          };
        },
      },
    },
  };
}
