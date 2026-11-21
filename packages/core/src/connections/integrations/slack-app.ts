// Rome's own Slack app connection. Channel contract: docs/architecture/channels.md.
//
// The guardian adds Rome to their Slack workspace in one sign-in: Connect,
// Slack's approve screen, done. Nothing is pasted and no Slack app is made by
// the guardian. The connection's account is the app's bot in that workspace,
// named by team id and bot user id. It takes an agent like any bot, and a new
// one starts with the Concierge. It is Rome's only connection to Slack.
//
// Rome Cloud holds the app's secrets, runs the exchange with Slack, and binds
// the workspace to this instance (one workspace, one instance). The instance
// holds the bot token, drains the workspace's relay mailbox for its events
// (`kinds/slack-app/slack-app.ts`) and replies through Slack's Web API.

import type { ChatId } from "@rome-os/app-runtime";
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    // Kept through a mailbox refresh, which writes the material back.
    ...(typeof record.generation === "string" ? { generation: record.generation } : {}),
  };
}

/** The claim of the workspace a grant's connect made, which its release
 *  names, kept in the material as `generation` (a decimal). Undefined for a
 *  grant made before Rome Cloud counted claims. */
function generationOf(material: unknown): number | undefined {
  const raw = (material as { generation?: unknown } | null)?.generation;
  if (typeof raw !== "string") return undefined;
  const generation = Number(raw);
  return Number.isInteger(generation) && generation > 0 ? generation : undefined;
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
        deps.cloud.redeem({ handoff, codeVerifier }, ctx.signal),
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
      ...(install.generation !== undefined ? { generation: String(install.generation) } : {}),
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
  /** The connection's own copy of the messages it hears and reads. */
  copy: SlackMessageCopy;
  /** Whether Rome listens to the account behind a connection. */
  listens: (connectionId: string) => boolean;
  instanceOrigin?: () => string;
}

/** How long a release of a workspace may run at Rome Cloud. */
const RELEASE_LIMIT_MS = 60_000;

/**
 * `cloud`, with each release fenced off from a later connect. Rome Cloud goes
 * on releasing after Rome stops waiting, and a release that lands after a
 * connect bound the workspace again would release that connection. So a
 * release runs to its end, or to {@link RELEASE_LIMIT_MS}, whoever stops
 * waiting for it, and a connect redeems its install only once every release
 * has ended. A release that outlasts that, or one Rome restarted under, is
 * fenced at Rome Cloud: it names the generation of the claim it ends, and a
 * later connect holds a newer one.
 *
 * A release also waits for every redeem already running, and names the newest
 * claim of its workspace this Rome was given. A setup cancelled while its
 * redeem ran, such as by the disconnect itself, has its claim made at Rome
 * Cloud all the same, and a release naming the older claim would leave that
 * one bound. This Rome holds one connection per workspace, so the newest claim
 * of the workspace is that connection's.
 */
export interface FencedSlackAppCloud extends SlackAppCloud {
  /** The bot tokens of the installs of `teamId` redeemed since this was last
   *  asked, once every redeem already running has ended. A setup cancelled
   *  while its redeem ran keeps no grant, so a disconnect revokes its token
   *  from here. */
  redeemedTokens(teamId: string): Promise<string[]>;
  /** The installs of workspaces other than `teamId` that a cancelled setup
   *  redeemed, such as a fix the guardian pointed at another workspace, once
   *  every redeem already running has ended. No grant holds them, so a
   *  disconnect revokes and releases each one. Each is handed out once. */
  cancelledElsewhere(teamId: string): Promise<SlackAppInstall[]>;
}

export function fencedCloud(cloud: SlackAppCloud): FencedSlackAppCloud {
  const releasing = new Set<Promise<void>>();
  const redeeming = new Set<Promise<void>>();
  const newest = new Map<string, number>();
  const tokens = new Map<string, Set<string>>();
  const cancelled: SlackAppInstall[] = [];
  return {
    start: (input) => cloud.start(input),
    refreshMailbox: (teamId) => cloud.refreshMailbox(teamId),
    async redeem(input, signal) {
      await Promise.allSettled([...releasing]);
      const run = cloud.redeem(input, signal).then((install) => {
        if (signal?.aborted) cancelled.push(install);
        const held = tokens.get(install.teamId) ?? new Set<string>();
        held.add(install.botToken);
        tokens.set(install.teamId, held);
        const generation = install.generation;
        if (generation !== undefined && generation > (newest.get(install.teamId) ?? 0)) {
          newest.set(install.teamId, generation);
        }
        return install;
      });
      const tracked: Promise<void> = run.then(
        () => {},
        () => {},
      );
      redeeming.add(tracked);
      void tracked.finally(() => redeeming.delete(tracked));
      return run;
    },
    async redeemedTokens(teamId) {
      await Promise.allSettled([...redeeming]);
      const held = [...(tokens.get(teamId) ?? [])];
      tokens.delete(teamId);
      // This workspace's cancelled installs are among `held`.
      for (let i = cancelled.length - 1; i >= 0; i--) {
        if (cancelled[i]?.teamId === teamId) cancelled.splice(i, 1);
      }
      return held;
    },
    async cancelledElsewhere(teamId) {
      await Promise.allSettled([...redeeming]);
      const elsewhere = cancelled.filter((install) => install.teamId !== teamId);
      for (const install of elsewhere) cancelled.splice(cancelled.indexOf(install), 1);
      return elsewhere;
    },
    release(teamId, signal, generation) {
      const pending = [...redeeming];
      const run = (async () => {
        await Promise.allSettled(pending);
        const claimed = newest.get(teamId);
        const named =
          generation !== undefined && claimed !== undefined && claimed > generation
            ? claimed
            : generation;
        await cloud.release(teamId, AbortSignal.timeout(RELEASE_LIMIT_MS), named);
      })();
      const tracked: Promise<void> = run.catch(() => {}).finally(() => releasing.delete(tracked));
      releasing.add(tracked);
      if (!signal) return run;
      return new Promise<void>((resolve, reject) => {
        const stop = () => reject(signal.reason ?? new Error("Rome stopped waiting"));
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, { once: true });
        run.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
      });
    },
  };
}

export function makeSlackAppDescriptor(input: SlackAppDescriptorDeps): ConnectionDescriptor {
  const deps = { ...input, cloud: fencedCloud(input.cloud) };
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
    // A task chat sends, reads and searches Slack through the connector's
    // proxy, which makes its calls through this connection's talker with the
    // bot grant.
    actsWithGrant: true,
    grant: "bot",
    auth: scheme,
    // Revoke the token at Slack, then release the workspace at Rome Cloud.
    // Removing the app in Slack does neither, so a fix through the same
    // sign-in returns the same connection. If the instance stops between the
    // two, the workspace stays bound with a dead token: the connection reads
    // broken, and a second disconnect, which takes a refused token as
    // revoked, finishes the release.
    async onDisconnect({ material: record }, { signal }) {
      const material = materialOf(record);
      // The grant's token, then any a fix cancelled by this disconnect was
      // given while its redeem ran, in this workspace or another the guardian
      // picked on Slack's screen: no grant holds those.
      let elsewhere: SlackAppInstall[] = [];
      try {
        await deps.api.revoke(material.botToken, signal);
        const orphaned = await deps.cloud.redeemedTokens(material.teamId);
        for (const token of orphaned) {
          if (token !== material.botToken) await deps.api.revoke(token, signal);
        }
        elsewhere = await deps.cloud.cancelledElsewhere(material.teamId);
        for (const install of elsewhere) await deps.api.revoke(install.botToken, signal);
      } catch (error) {
        throw new Error(`Slack did not revoke Rome's token (${describe(error)})`);
      }
      // Past the disconnect's wait, the workspace may be connected again, and
      // releasing it now would release that connection. A release already
      // under way holds off a connect until it ends (fencedCloud), and names
      // this connect's claim, so one that lands later still, or after a
      // restart, ends nothing newer.
      if (signal.aborted) throw new Error("Rome stopped waiting before releasing the workspace");
      try {
        await deps.cloud.release(material.teamId, signal, generationOf(record));
        // Phase 1 holds one workspace per Rome, so another workspace's claim
        // is the cancelled fix's alone.
        for (const install of elsewhere) {
          await deps.cloud.release(install.teamId, signal, install.generation);
        }
      } catch (error) {
        throw new Error(`Rome Cloud did not release the workspace (${describe(error)})`);
      }
    },
    capabilities: {
      talker: {
        // Every read asks Slack (slack-app/timeline.ts).
        reads: true,
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
