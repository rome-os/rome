// Rome's own Slack app connection. Channel contract: docs/architecture/channels.md.
//
// The guardian adds Rome to their Slack workspace in one sign-in: Connect,
// Slack's approve screen, done. Nothing is pasted and no Slack app is made by
// the guardian. The connection's account is the app's bot in that workspace,
// named by team id and bot user id. It takes an agent like any bot, and a new
// one starts with the Concierge. It is Rome's only connection to Slack.
//
// The Slack gateway Worker holds the app, every workspace's bot token and the
// workspace-to-instance binding (one workspace, one instance); Rome Cloud signs
// the link that adds the app. The instance holds no Slack token: its grant
// keeps the key the Worker signs its deposits with, events arrive in the
// instance's relay mailbox (`kinds/slack-app/slack-app.ts`), and replies and
// reads go through the Worker (`kinds/slack-app/web-api.ts`).

import type { ChatId } from "@rome-os/app-runtime";
import { z } from "zod";
import { createLogger } from "../../logger.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { isSlackCredentialError, SlackApiError } from "../kinds/slack/slack.js";
import {
  isSlackAppCredentialError,
  type SlackAppCloud,
  SlackAppRefused,
  type SlackAppWorkspace,
} from "../kinds/slack-app/rome-cloud.js";
import { type MailboxFrame, SlackAppAdapter } from "../kinds/slack-app/slack-app.js";
import type { SlackAppWebApi } from "../kinds/slack-app/web-api.js";
import type { SetupFn } from "../setup/types.js";
import { directoryPage } from "./talk-features.js";
import type {
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  SecretRecord,
  Talker,
} from "../types.js";

const log = createLogger("slack-app");

export const SLACK_APP_KIND = "slack_app";

/** The grant's profile: the bot in one workspace, and who added it. */
export const slackAppGrantProfileSchema = z
  .object({
    teamId: z.string().min(1),
    workspaceName: z.string().min(1).optional(),
    botUserId: z.string().min(1),
    /** Kept by a grant made before the Slack gateway Worker. */
    appId: z.string().min(1).optional(),
    /** The workspace member who approved the app: the guardian there. */
    installerUserId: z.string().min(1).optional(),
  })
  .strict();
export type SlackAppGrantProfile = z.infer<typeof slackAppGrantProfileSchema>;

/** The grant's material: the workspace and bot it answers as, and the key the
 *  Worker signs this instance's deposits with. No Slack token. */
export interface SlackAppMaterial extends SecretRecord {
  teamId: string;
  botUserId: string;
  depositKey: string;
}

/** What a grant made before the Slack gateway Worker says: it held Slack's
 *  token on the instance, which Rome no longer keeps. */
export const REAPPROVE_FOR_GATEWAY =
  "Rome's Slack app now keeps its Slack token in Rome Cloud. Approve the app again from Slack in Settings › Connections.";

export function toSlackAppDisplay(profile: SlackAppGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.workspaceName ? `Rome (${profile.workspaceName})` : "Rome",
    handle: undefined,
    email: undefined,
    avatarUrl: undefined,
  });
}

/** The bot is named by its workspace and its bot user, since Slack issues
 *  user ids per workspace. */
export function slackAppAccountId(record: ProfileRecord): string | null {
  const { teamId, botUserId } = record;
  return typeof teamId === "string" && teamId && typeof botUserId === "string" && botUserId
    ? `${teamId}/${botUserId}`
    : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The grant's material, or null for a grant made before the Worker, which
 *  held a Slack token and no deposit key. */
function materialOf(material: unknown): SlackAppMaterial | null {
  const record = material as Partial<SlackAppMaterial> | null;
  if (
    typeof record?.teamId !== "string" ||
    typeof record.botUserId !== "string" ||
    typeof record.depositKey !== "string" ||
    !record.depositKey
  ) {
    return null;
  }
  return { teamId: record.teamId, botUserId: record.botUserId, depositKey: record.depositKey };
}

/** How often the setup asks the Worker whether Slack's approve screen was
 *  passed, and for how long: Rome Cloud's link lasts ten minutes. */
const APPROVAL_POLL_MS = 2_000;
const APPROVAL_LIMIT_MS = 10 * 60 * 1000;

export interface SlackAppSetupDeps {
  cloud: SlackAppCloud;
  /** The public address of this instance's relay mailbox, or null while Rome
   *  Cloud has not given one. Read on each connect. */
  depositUrl: () => Promise<string | null>;
  /** How often and how long the setup waits for Slack's approval. */
  approval?: { pollMs: number; limitMs: number };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The workspace bound to this instance since `before` was listed: a new one,
 *  or one bound again by approving the app once more. */
async function approved(
  cloud: SlackAppCloud,
  before: SlackAppWorkspace[],
  approval: { pollMs: number; limitMs: number },
  signal: AbortSignal,
): Promise<SlackAppWorkspace> {
  const boundAt = new Map(before.map((workspace) => [workspace.teamId, workspace.boundAt]));
  const until = Date.now() + approval.limitMs;
  while (Date.now() < until) {
    await wait(approval.pollMs, signal);
    let now: SlackAppWorkspace[];
    try {
      now = await cloud.workspaces(signal);
    } catch (error) {
      if (signal.aborted || isSlackAppCredentialError(error)) throw error;
      log.warn("slack app setup could not list workspaces; asking again", {
        error: describe(error),
      });
      continue;
    }
    const added = now.find((workspace) => workspace.boundAt > (boundAt.get(workspace.teamId) ?? 0));
    if (added) return added;
  }
  throw new Error("Slack was not added. Press Connect again when you are ready.");
}

/**
 * Connect, as one coroutine: tell the Worker where this instance's mailbox is,
 * send the guardian to Slack's approve screen through Rome Cloud's link, and
 * wait for the Worker to hold the workspace. No form. The member who approved
 * is mapped as the guardian on this connection, so their direct messages are
 * the guardian's from the first one.
 */
export function makeSlackAppSetup(deps: SlackAppSetupDeps): SetupFn {
  return async (interact, ctx) => {
    const depositUrl = await deps.depositUrl();
    if (!depositUrl)
      throw new Error("Rome can't receive Slack messages yet. Try again in a minute.");
    let workspace: SlackAppWorkspace;
    let depositKey: string;
    try {
      const connected = await ctx.step("slack-app-connect", (signal) =>
        deps.cloud.connect(depositUrl, signal),
      );
      depositKey = connected.depositKey;
      const url = await ctx.step("slack-app-install-url", (signal) =>
        deps.cloud.installUrl(signal),
      );
      interact.show({
        title: "Add Rome to Slack",
        body: [
          "Approve Rome's Slack app for your workspace in Slack. This page moves on once Slack says it is added.",
        ],
        links: [{ label: "Open Slack", url }],
        progress: true,
      });
      workspace = await ctx.step("slack-app-approved", (signal) =>
        approved(
          deps.cloud,
          connected.workspaces,
          deps.approval ?? { pollMs: APPROVAL_POLL_MS, limitMs: APPROVAL_LIMIT_MS },
          signal,
        ),
      );
    } catch (error) {
      // The Worker's and Rome Cloud's refusals are written for the guardian.
      if (error instanceof SlackAppRefused) throw new Error(error.message);
      throw error;
    }

    const profile = slackAppGrantProfileSchema.parse({
      teamId: workspace.teamId,
      botUserId: workspace.botUserId,
      ...(workspace.teamName ? { workspaceName: workspace.teamName } : {}),
      ...(workspace.installerUserId ? { installerUserId: workspace.installerUserId } : {}),
    });
    const material: SlackAppMaterial = {
      teamId: workspace.teamId,
      botUserId: workspace.botUserId,
      depositKey,
    };
    const name = workspace.teamName || "your workspace";
    return {
      credential: { material, expiresAt: "never" },
      profile,
      ...(workspace.installerUserId
        ? {
            guardianChannelUserId: `${workspace.teamId}/${workspace.installerUserId}`,
            addsGuardianAccount: true,
          }
        : {}),
      summary: {
        title: "Slack connected",
        body: [`Rome is in ${name}. Send it a direct message in Slack.`],
      },
    };
  };
}

/** Give access through the setup only. Without the guardian the grant cannot
 *  be renewed: a workspace the Worker let go needs the same sign-in again. */
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
  /** The public address of this instance's relay mailbox, or null while Rome
   *  Cloud has not given one. */
  depositUrl: () => Promise<string | null>;
  /** How many times the mailbox's drain delivers one frame before it holds it. */
  deliveryAttempts: number;
  /** Has the instance's mailbox drained while the connection runs, and
   *  retries a frame it gave up on while the connection was down; the
   *  returned function lets go. */
  claimMailbox?: () => () => void;
  /** Whether Rome listens to the account behind a connection. */
  listens: (connectionId: string) => boolean;
  approval?: { pollMs: number; limitMs: number };
}

export function makeSlackAppDescriptor(deps: SlackAppDescriptorDeps): ConnectionDescriptor {
  const scheme = slackAppScheme();
  scheme.setup = makeSlackAppSetup(deps);
  return {
    connectionKind: SLACK_APP_KIND,
    label: "Slack",
    // Phase 1 connects one workspace. Adding another goes through a setup
    // that waits for whichever workspace is approved next.
    reviveProfile: (record) => toSlackAppDisplay(slackAppGrantProfileSchema.parse(record)),
    accountIdOf: (record) => slackAppAccountId(record),
    link: "own_account",
    // A new workspace answers as the guardian's Concierge from its first
    // message (docs/adrs/channels-and-connectors-are-one-connection.md).
    startsWithConcierge: true,
    // An official app offers no chat rules: every chat runs at the defaults.
    chatRules: { offers: [] },
    // A task chat sends, reads and searches Slack through the connector's
    // proxy, which makes its calls through this connection's talker with the
    // bot grant.
    actsWithGrant: true,
    grant: "bot",
    auth: scheme,
    // The Worker revokes each of this instance's tokens at Slack and lets go
    // of its workspaces, so another Rome may connect them. Removing the app in
    // Slack does neither on the instance's side, so a fix through the same
    // sign-in returns the same connection.
    async onDisconnect(_grant, { signal }) {
      try {
        await deps.cloud.disconnect(signal);
      } catch (error) {
        throw new Error(`Rome's Slack service did not let go of this Rome (${describe(error)})`);
      }
    },
    capabilities: {
      talker: {
        // Every read asks Slack (slack-app/timeline.ts).
        reads: true,
        build(cred, kit): Talker {
          const material = materialOf(cred.material);
          if (!material) {
            // A grant from before the Worker held Slack's token on the
            // instance. Nothing here can use it: the connection says it needs
            // approving again.
            const refused = new CredentialRejected({
              grant: "bot",
              cause: new SlackApiError("not_authed", REAPPROVE_FOR_GATEWAY),
            });
            return {
              start(_deliver, fault): void {
                queueMicrotask(() => fault(refused));
              },
              stop() {},
              async send() {
                throw refused;
              },
            };
          }
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          const routeFault = (cause: unknown, kind?: "credential" | "transport"): void => {
            const credential = kind ? kind === "credential" : isSlackCredentialError(cause);
            faultSink?.(
              credential
                ? new CredentialRejected({ grant: "bot", cause })
                : new Disconnected(cause),
            );
          };
          const holds = (workspaces: SlackAppWorkspace[]) =>
            workspaces.some(
              (workspace) =>
                workspace.teamId === material.teamId && workspace.botUserId === material.botUserId,
            );
          let depositKey = material.depositKey;
          const adapter = new SlackAppAdapter({
            channel: SLACK_APP_KIND,
            teamId: material.teamId,
            botUserId: material.botUserId,
            depositKey,
            api: deps.api,
            bound: async () => holds(await deps.cloud.workspaces()),
            deliveryAttempts: deps.deliveryAttempts,
            onFault: ({ kind, cause }) => routeFault(cause, kind),
            listened: () => deps.listens(kit.connectionId),
          });
          let unregister: (() => void) | null = null;
          let releaseMailbox: (() => void) | null = null;

          // Each start tells the Worker where this instance's mailbox is now,
          // and checks it still holds the workspace for this instance. The
          // Worker keeps the key across connects and makes a new one only
          // after it forgot this instance, which the grant then keeps. A
          // failure to reach it keeps the stored key, which still checks what
          // the mailbox holds.
          const refresh = async () => {
            const depositUrl = await deps.depositUrl();
            if (!depositUrl) return;
            try {
              const connected = await deps.cloud.connect(depositUrl);
              if (!holds(connected.workspaces)) {
                routeFault(
                  new SlackApiError(
                    "app_uninstalled",
                    "Rome Cloud no longer holds this Slack workspace for this Rome.",
                  ),
                  "credential",
                );
                return;
              }
              if (connected.depositKey === depositKey) return;
              await kit.persist({
                ...material,
                depositKey: connected.depositKey,
              } satisfies SlackAppMaterial);
              depositKey = connected.depositKey;
              adapter.setDepositKey(depositKey);
            } catch (error) {
              if (isSlackAppCredentialError(error)) {
                routeFault(error, "credential");
                return;
              }
              log.warn("slack connect on start failed; keeping the stored key", {
                error: describe(error),
              });
            }
          };

          return {
            // The mailbox is told a message is had only once Chats has it on
            // record, so `deliver` must hand back its acceptance.
            awaitsAcceptance: true,
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onInbound(deliver);
              adapter.start();
              unregister = kit.registerIngress(async (input) => {
                const frame = input as Partial<MailboxFrame> | null;
                return adapter.handleFrame({
                  headers: frame?.headers ?? {},
                  body: frame?.body ?? null,
                });
              });
              // Last, so a frame the mailbox retries at once finds the ingress.
              releaseMailbox = deps.claimMailbox?.() ?? null;
              void refresh();
            },
            stop() {
              unregister?.();
              unregister = null;
              releaseMailbox?.();
              releaseMailbox = null;
              adapter.stop();
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
            history: {
              async read(chatId, read) {
                try {
                  return await adapter.readHistory(chatId, read);
                } catch (error) {
                  if (isSlackCredentialError(error)) {
                    throw new CredentialRejected({ grant: "bot", cause: error });
                  }
                  throw error;
                }
              },
            },
            // The channels the app is a member of, by name, for chat settings
            // and for an agent that names a channel.
            directory: {
              async listConversations(input) {
                const query = input.query?.replace(/^#/, "").toLocaleLowerCase();
                let channels: Awaited<ReturnType<typeof adapter.channels>>;
                try {
                  channels = await adapter.channels();
                } catch (error) {
                  if (isSlackCredentialError(error)) {
                    throw new CredentialRejected({ grant: "bot", cause: error });
                  }
                  throw error;
                }
                const page = directoryPage(
                  channels.filter(
                    (channel) => !query || channel.name.toLocaleLowerCase().includes(query),
                  ),
                  input,
                );
                return {
                  conversations: page.items.map((channel) => ({
                    ref: { connectionId: kit.connectionId, chatId: channel.id as ChatId },
                    connectionKind: SLACK_APP_KIND,
                    service: SLACK_APP_KIND,
                    kind: "channel" as const,
                    displayName: `#${channel.name}`,
                  })),
                  ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                };
              },
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
