import type { TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import {
  SlackAdapter,
  type SlackBotIdentity,
  type SlackIngress,
  SLACK_REQUIRED_BOT_SCOPES,
  type SlackWebApi,
  generateSlackGuardianLinkCode,
  isSlackCredentialError,
  slackWebApi,
  waitForSlackGuardianLink,
} from "../../channels/slack.js";
import { clearProviderTokenFile } from "../../lib/provider-token-files.js";
import type { SetupFn } from "../setup/types.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import type { GrantLedger } from "../ledger.js";
import type { ConnectionDescriptor, Credential, Talker } from "../types.js";
import {
  makeOAuthProviderDescriptor,
  slackGrantProfileSchema,
  type OAuthProviderSetupDeps,
  type SlackGrantProfile,
} from "./oauth-providers.js";

export interface SlackDescriptorDeps extends OAuthProviderSetupDeps {
  ingress: SlackIngress;
  api?: SlackWebApi;
  generateVerificationCode?: () => string;
}

const GUARDIAN_LINK_REQUIRED_REASON = "Reconnect Slack in Settings to link the guardian identity.";

function credentialMaterial(credential: Credential): { botToken: string; userToken?: string } {
  if (typeof credential.material === "function") {
    throw new Error("Slack OAuth returned an unsupported external credential.");
  }
  const botToken = credential.material.botToken?.trim();
  if (!botToken) throw new Error("Slack OAuth returned no bot token.");
  return {
    botToken,
    ...(credential.material.userToken ? { userToken: credential.material.userToken } : {}),
  };
}

/**
 * Keep a Slack workspace grant locked until its setup has linked the guardian.
 * The connector-only OAuth path carries no guardian proof. The credential
 * stays inert so reconnect can replace it, and its custody file is removed.
 */
export async function lockUnlinkedSlackTalk(
  ledger: GrantLedger,
  options: { enabled?: boolean; now?: Date; clearCustody?: () => Promise<void> } = {},
): Promise<void> {
  // A connector-only Slack grant must remain usable on hosts that do not offer
  // bot conversations. Such a host cannot complete the guardian-link recovery,
  // so migrating it to degraded would strand the connection permanently.
  if (options.enabled === false) return;
  let locked = false;
  const degradedAt = options.now ?? new Date();
  const connections = await ledger.listConnections();
  for (const connection of connections) {
    if (connection.service !== "slack") continue;
    const grant = await ledger.getGrant(connection.id, "workspace");
    if (grant?.state !== "authorized") continue;
    const linked =
      typeof grant.profile?.guardianChannelUserId === "string" &&
      grant.profile.guardianChannelUserId.length > 0;
    if (linked) continue;
    await ledger.updateGrant(connection.id, "workspace", {
      state: "degraded",
      degraded: { at: degradedAt, reason: GUARDIAN_LINK_REQUIRED_REASON },
    });
    locked = true;
  }
  if (locked) await (options.clearCustody ?? (() => clearProviderTokenFile("slack")))();
}

export function missingSlackBotScopes(scopes: readonly string[] | undefined): string[] {
  const present = new Set(scopes ?? []);
  return SLACK_REQUIRED_BOT_SCOPES.filter((scope) => !present.has(scope));
}

function enrichedSlackProfile(
  profile: SlackGrantProfile,
  identity: SlackBotIdentity,
  guardianChannelUserId: string,
): SlackGrantProfile {
  return slackGrantProfileSchema.parse({
    ...profile,
    teamId: identity.teamId,
    workspaceName: identity.workspaceName ?? profile.workspaceName,
    botUserId: identity.botUserId,
    botUsername: identity.botUsername ?? profile.botUsername,
    guardianChannelUserId,
  });
}

/**
 * Slack's OAuth setup stays pending until the dashboard guardian proves their
 * Slack identity by DMing the one-time code. Credential, workspace/bot profile,
 * and guardian mapping then commit atomically through SetupManager.
 */
export function makeSlackSetup(deps: SlackDescriptorDeps): SetupFn {
  const api = deps.api ?? slackWebApi;
  const generateCode = deps.generateVerificationCode ?? generateSlackGuardianLinkCode;
  return async (interact, ctx) => {
    if (!deps.ingress.configured) {
      throw new Error(
        "Slack bot events are not configured on this Rome instance. Set SLACK_SIGNING_SECRET first.",
      );
    }

    const url = await deps.beginRedirect();
    const returned = await interact.redirect(url);
    if (typeof returned.error === "string" && returned.error) {
      throw new Error(
        returned.error === "access_denied"
          ? "Authorization was declined."
          : `Authorization failed: ${returned.error}`,
      );
    }
    const handoff = typeof returned.handoff === "string" ? returned.handoff.trim() : "";
    const state = typeof returned.state === "string" ? returned.state.trim() : "";
    if (!handoff || !state) throw new Error("The authorization return was incomplete.");

    interact.show({ body: ["Checking the Slack workspace and Rome bot…"], progress: true });
    const redeemed = await ctx.step("oauth-redeem", () => deps.redeem(handoff, state));
    const material = credentialMaterial(redeemed.credential);
    const profile = slackGrantProfileSchema.parse(redeemed.profile ?? {});
    const missingScopes = missingSlackBotScopes(profile.scopes);
    if (missingScopes.length > 0) {
      throw new Error(
        `Slack did not grant the bot permissions Rome needs: ${missingScopes.join(", ")}. Reconnect after updating the Slack app configuration.`,
      );
    }

    const identity = await ctx.step("slack-bot-identity", (signal) =>
      api.authTest(material.botToken, signal),
    );
    if (profile.teamId && profile.teamId !== identity.teamId) {
      throw new Error("Slack authorized a different workspace than the bot token belongs to.");
    }

    const code = generateCode();
    // Subscribe before the instructions reach the browser so an immediate DM
    // cannot land in the gap between showing the code and installing the waiter.
    const guardianLink = ctx.step("slack-guardian-link", (signal) =>
      waitForSlackGuardianLink(deps.ingress, identity, code, signal),
    );
    interact.show({
      title: "Link your Slack account",
      body: [
        `${identity.workspaceName ?? "Your Slack workspace"} connected as @${identity.botUsername ?? "Rome"}.`,
        "To finish linking your account as guardian, send this exact code in a direct message to the Rome bot:",
        code,
        "The code expires in five minutes and locks a sender after five incorrect attempts.",
      ],
      steps: [{ text: `Send ${code} to @${identity.botUsername ?? "Rome"} in Slack` }],
      progress: true,
    });
    const { channelUserId } = await guardianLink;

    return {
      credential: redeemed.credential,
      profile: enrichedSlackProfile(profile, identity, channelUserId),
      guardianChannelUserId: channelUserId,
      summary: {
        title: "Slack connected",
        body: [
          `${identity.workspaceName ?? "Your workspace"} is connected. @${identity.botUsername ?? "Rome"} is ready for direct messages and channel mentions.`,
        ],
      },
    };
  };
}

export function makeSlackDescriptor(deps: SlackDescriptorDeps): ConnectionDescriptor {
  const descriptor = makeOAuthProviderDescriptor("slack");
  descriptor.connectAvailability = () =>
    deps.ingress.configured
      ? { available: true, unavailableReason: null }
      : {
          available: false,
          unavailableReason: "Slack bot events are not configured on this Rome instance.",
        };
  descriptor.auth.workspace.setup = makeSlackSetup(deps);
  descriptor.capabilities.talker = {
    needs: ["workspace"] as const,
    build(creds, kit): Talker {
      const material = credentialMaterial(creds.workspace);
      const profile = slackGrantProfileSchema.parse(kit.profile("workspace") ?? {});
      if (!profile.guardianChannelUserId) {
        throw new Error(GUARDIAN_LINK_REQUIRED_REASON);
      }
      let faultSink: ((error: CredentialRejected | Disconnected) => void) | null = null;
      const adapter = new SlackAdapter({
        botToken: material.botToken,
        ingress: deps.ingress,
        api: deps.api,
        onCredentialFault: (cause) => {
          faultSink?.(new CredentialRejected({ grant: "workspace", cause }));
        },
      });

      return {
        start(deliver, fault): void {
          faultSink = fault;
          adapter.onMessage(deliver);
          adapter.start().catch((error) => {
            faultSink?.(
              isSlackCredentialError(error)
                ? new CredentialRejected({ grant: "workspace", cause: error })
                : new Disconnected(error),
            );
          });
        },
        stop(): void {
          adapter.stop();
        },
        async send(conversationId, message) {
          try {
            const sent = await adapter.send(conversationId, message);
            return { conversationId, messageId: sent.ts };
          } catch (error) {
            if (isSlackCredentialError(error)) {
              throw new CredentialRejected({ grant: "workspace", cause: error });
            }
            throw error;
          }
        },
        feature<K extends TalkFeatureName>(_name: K): TalkFeatureMap[K] | null {
          return null;
        },
      };
    },
  };
  return descriptor;
}
