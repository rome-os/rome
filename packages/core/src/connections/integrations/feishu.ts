// Feishu and Lark connection integration. Channel contract: docs/architecture/channels.md.
//
// Feishu is a Talker with a single `app` grant: the custom-app credentials
// (appId + appSecret) plus the domain (feishu vs. lark). The transport core —
// the SDK long connection, the inbound `ChannelMessage`, markdown send, and the
// group-config card flow — is the existing
// `FeishuAdapter` (packages/core/src/channels/feishu.ts), wrapped here so the
// runtime's grant-epoch lifecycle and fault→grant-state mapping drive it. The
// transport already speaks the channel's record, so inbound and send pass
// through without a projection.
//
// The `app` grant is conferred by pasting the two fields (`credentialsPaste`);
// `validate` mints a tenant-access-token via a transient connect so a bad
// appId/appSecret is refused at confer time.
//
// Fault mapping: a tenant-access-token auth failure
// (`isFeishuAuthError`) is a CredentialRejected{ grant: "app" }; every other
// long-connection terminal error is a Disconnected. A bad-credential
// `channel.connect()` at start rejects out of `adapter.start()`, routed the same
// way; ongoing `error` events route through the adapter's `onFault` seam.

import {
  createLarkChannel,
  type CardActionEvent,
  Domain,
  type LarkChannel,
  LoggerLevel,
  type NormalizedMessage as LarkMessage,
} from "@larksuiteoapi/node-sdk";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import type { ConversationSettingsService } from "../../conversation-settings/service.js";
import {
  type CreateLarkChannel,
  FeishuAdapter,
  type FeishuConfig,
  isFeishuAuthError,
} from "../../channels/feishu.js";
import { z } from "zod";
import { CredentialRejected, Disconnected } from "../errors.js";
import { credentialsPaste } from "../schemes.js";
import type { SetupFn, SetupView } from "../setup/types.js";
import type { ChannelActivity } from "@rome-os/app-runtime";
import type { TalkDirectory, TalkFeatures } from "../types.js";
import type {
  ConnectionDescriptor,
  ProfileDisplay,
  ProfileRecord,
  SecretRecord,
  Talker,
} from "../types.js";
import { addressIsConversationFeature, directoryPage } from "./talk-features.js";
import { createLogger } from "../../logger.js";

const log = createLogger("feishu-setup");

/** The `app` grant material — the custom-app credentials (see feishu.ts). */
export interface FeishuAppMaterial {
  appId: string;
  appSecret: string;
  /** "feishu" = open.feishu.cn (China), "lark" = open.larksuite.com. */
  domain?: "feishu" | "lark";
  /** Reserved for future custom-vs-store distinction; carried through opaquely. */
  appType?: string;
}

// The `app` grant's profile — the non-secret half of the custom-app identity
// (appId, the bot's name, which tenant domain, app type). Declared next to the
// material shape; parse-then-store, and the same schema re-runs on revive
// (fail-closed). `botName` and `appId` are the display fields; `domain`/`appType`
// stay owner-side. All optional so a bridge-era grant with no captured identity
// stays sparse-but-valid.
export const feishuGrantProfileSchema = z
  .object({
    appId: z.string().min(1).optional(),
    botName: z.string().min(1).optional(),
    domain: z.enum(["feishu", "lark"]).optional(),
    appType: z.string().min(1).optional(),
  })
  .strict();
export type FeishuGrantProfile = z.infer<typeof feishuGrantProfileSchema>;

/** Pure display projection: the bot's name reads as the display name and the
 *  appId as the handle. `domain`/`appType` are owner-side and never widen the
 *  display surface. */
export function toFeishuDisplay(profile: FeishuGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.botName,
    handle: profile.appId,
    email: undefined,
    avatarUrl: undefined,
  });
}

/** Revive a stored feishu profile: re-parse with the schema, then map through the
 *  pure display function (fail-closed on a record that no longer matches). */
export function reviveFeishuProfile(record: ProfileRecord): ProfileDisplay {
  return toFeishuDisplay(feishuGrantProfileSchema.parse(record));
}

/** The identity fields the feishu settings row carries. `domain` is untrusted
 *  persisted JSON — typed `unknown` so a wrong-typed value reaches the strict
 *  enum parse instead of being dropped before it. */
export interface FeishuProfileSource {
  appId?: string;
  botName?: string;
  domain?: unknown;
  appType?: string;
}

/** Build the parsed grant profile from the settings row, or null when the row
 *  carries no identity to record (null / undefined / "" are the absent cases).
 *  Every other present value flows through untouched so the strict parse — not
 *  this picker — decides validity: a wrong-typed value fails loudly, never
 *  silently dropped or coerced. */
export function feishuProfileFromSettings(
  settings: FeishuProfileSource,
): FeishuGrantProfile | null {
  const raw: Record<string, unknown> = {};
  if (settings.appId != null && settings.appId !== "") raw.appId = settings.appId;
  if (settings.botName != null && settings.botName !== "") raw.botName = settings.botName;
  if (settings.domain != null && settings.domain !== "") raw.domain = settings.domain;
  if (settings.appType != null && settings.appType !== "") raw.appType = settings.appType;
  if (Object.keys(raw).length === 0) return null;
  return feishuGrantProfileSchema.parse(raw);
}

/**
 * The runtime deps the FeishuAdapter needs, threaded from index.ts at
 * registration time (the composition root has the repos): the shared settings
 * control, person repo, and loaded-agent lister the group-config
 * card offers. `createChannel` is injectable so tests drive a fake LarkChannel.
 */
export interface FeishuDescriptorDeps {
  conversationSettings: ConversationSettingsService;
  personMappingRepo: PersonMappingRepository;
  listAgents: () => string[];
  createChannel?: CreateLarkChannel;
  /** Injectable setup seams so tests drive the ceremony without the
   *  network / SDK long connection. Production uses the defaults below. */
  probeCredentials?: FeishuSetupDeps["probeCredentials"];
  registerAgentApp?: FeishuSetupDeps["registerAgentApp"];
  fetchBotName?: FeishuSetupDeps["fetchBotName"];
}

/** The credential fields a Feishu setup holds before conferral (the pending,
 *  un-set-up material the in-ceremony probes run against). */
export interface FeishuPendingMaterial {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}

/** A QR handed to the setup while the SDK's registerApp flow waits for the
 *  guardian's scan. `qrDataUrl` may be null when encoding failed — the `url`
 *  link alone stays semantically complete. */
export interface FeishuAgentReadyQr {
  url: string;
  qrDataUrl: string | null;
  expiresAt: string | null;
}

/** The seams the Feishu setup coroutine runs against. Production defaults hit
 *  the Feishu/Lark SDK; tests inject fakes. */
export interface FeishuSetupDeps {
  /** Probe-validate pasted credentials (mint a tenant access token). Throws
   *  with a guardian-readable message when the pair is refused. */
  probeCredentials: (material: FeishuPendingMaterial, signal?: AbortSignal) => Promise<void>;
  /** The bot's name as Feishu shows it, or null when it has none. Setup goes
   *  on without a name when this rejects: the account then reads as its appId. */
  fetchBotName: (material: FeishuPendingMaterial, signal: AbortSignal) => Promise<string | null>;
  /**
   * The agent-ready dance: drive the SDK's `registerApp` QR flow (which MINTS
   * fresh app credentials — it runs against no adapter and no prior
   * credential) and resolve with the minted pair + the tenant-resolved domain.
   * `onQrCode` fires when the scannable QR is ready so the setup can present
   * it mid-step. Must honor the abort signal.
   */
  registerAgentApp: (opts: {
    domain: "feishu" | "lark";
    signal: AbortSignal;
    onQrCode: (qr: FeishuAgentReadyQr) => void;
  }) => Promise<FeishuPendingMaterial>;
}

const FEISHU_MODE_FORM = {
  instructions:
    "Choose how to connect: agent-ready scans a QR code to create Rome's app in your " +
    "tenant automatically; manual pastes an existing custom app's credentials. " +
    "Domain: feishu = open.feishu.cn (China), lark = open.larksuite.com (International).",
  fields: [
    { name: "mode", label: "Setup method", secret: false, options: ["agent-ready", "manual"] },
    { name: "domain", label: "Domain", secret: false, options: ["feishu", "lark"] },
  ],
};

const FEISHU_CREDENTIALS_FORM = {
  instructions: "Paste your Feishu/Lark custom-app App ID and App Secret.",
  fields: [
    { name: "appId", label: "App ID", secret: false },
    { name: "appSecret", label: "App secret", secret: true },
  ],
};

function agentReadyPreparingView(): SetupView {
  return {
    title: "Creating the agent app",
    body: ["Preparing the app-creation QR code…"],
    progress: true,
  };
}

function agentReadyQrView(qr: FeishuAgentReadyQr): SetupView {
  return {
    title: "Scan to create the agent app",
    body: [
      "Scan this QR code in the Feishu/Lark mobile app to create Rome's agent app in your tenant.",
      ...(qr.expiresAt ? [`The QR code expires at ${qr.expiresAt}.`] : []),
    ],
    links: [
      { label: "Open the app-creation page", url: qr.url },
      // A data-url link renders as the QR image; the https link above keeps the
      // payload complete for any renderer that shows links as links.
      ...(qr.qrDataUrl ? [{ label: "QR code", url: qr.qrDataUrl }] : []),
    ],
    progress: true,
  };
}

/** How long setup waits for the bot's name before going on without it. */
const BOT_NAME_TIMEOUT_MS = 5_000;

/** `work`, or a rejection once `signal` aborts, whichever comes first. A
 *  fetcher that ignores its signal still cannot hold the setup past it. */
function settledBefore<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function makeFeishuSetup(deps: FeishuSetupDeps): SetupFn {
  return async (interact, ctx) => {
    const { mode, domain: domainChoice } = await interact.prompt(FEISHU_MODE_FORM);
    const domain: "feishu" | "lark" = domainChoice === "lark" ? "lark" : "feishu";

    let pending: FeishuPendingMaterial;
    let appType: "agent_ready" | "manual";
    if (mode === "manual") {
      appType = "manual";
      let error: string | undefined;
      for (;;) {
        const { appId, appSecret } = await interact.prompt({
          ...FEISHU_CREDENTIALS_FORM,
          ...(error ? { error } : {}),
        });
        try {
          // Thread the setup's abort signal into the probe so a cancel
          // interrupts the in-flight validation rather than waiting it out.
          await deps.probeCredentials({ appId, appSecret, domain }, ctx.signal);
          pending = { appId, appSecret, domain };
          break;
        } catch (err) {
          // A cancel that aborted the probe must unwind the setup, not re-prompt.
          if (ctx.signal.aborted) throw err;
          error = err instanceof Error ? err.message : "Invalid App ID or App Secret.";
        }
      }
    } else {
      appType = "agent_ready";
      interact.show(agentReadyPreparingView());
      pending = await ctx.step("agent-ready", (signal) =>
        deps.registerAgentApp({
          domain,
          signal,
          // The QR arrives while the coroutine is parked inside the step;
          // showing it replaces the presented snapshot for every poller.
          onQrCode: (qr) => interact.show(agentReadyQrView(qr)),
        }),
      );
    }

    // Domain (and appType) are duplicated into material and profile by the one
    // atomic write, so the two halves cannot disagree.
    const material: SecretRecord = {
      appId: pending.appId,
      appSecret: pending.appSecret,
      domain: pending.domain,
      appType,
    };
    let botName: string | undefined;
    interact.show({ title: "Finishing setup", body: ["Reading the bot's name…"], progress: true });
    try {
      botName =
        (await ctx.step("bot-name", (signal) => {
          const bounded = AbortSignal.any([signal, AbortSignal.timeout(BOT_NAME_TIMEOUT_MS)]);
          return settledBefore(bounded, deps.fetchBotName(pending, bounded));
        })) ?? undefined;
    } catch (err) {
      // A cancel unwinds the setup; any other failure only costs the name.
      if (ctx.signal.aborted) throw err;
      log.warn("feishu_setup.bot_name_unread", {
        appId: pending.appId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const profile =
      feishuProfileFromSettings({
        appId: pending.appId,
        botName,
        domain: pending.domain,
        appType,
      }) ?? undefined;
    return {
      credential: { material, expiresAt: "never" },
      profile,
      summary: {
        title: "Feishu connected",
        body: [
          `App ${pending.appId} is live. Send the bot a private message, then approve your account in Settings → Connections or Activity.`,
        ],
      },
    };
  };
}

/** Default credentials probe: mint a tenant access token via the SDK client
 *  (targets the right host for the chosen domain). A non-zero response code
 *  means the pair is refused. */
async function probeFeishuCredentials(material: FeishuPendingMaterial): Promise<void> {
  const client = await feishuClient(material);
  let res: { code?: number; msg?: string };
  try {
    res = await client.auth.v3.tenantAccessToken.internal({
      data: { app_id: material.appId, app_secret: material.appSecret },
    });
  } catch {
    throw new Error("Failed to connect to the Feishu API.");
  }
  if (res.code !== 0) {
    throw new Error(res.msg || "Invalid App ID or App Secret");
  }
}

/** Discards the SDK's own logging. Its default logs a failed request's whole
 *  error, whose headers carry the tenant access token; callers report the
 *  failure themselves. */
const silentSdkLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

/** An SDK client for `material`'s app, on the host of its domain. */
async function feishuClient(material: FeishuPendingMaterial) {
  const { Client, Domain: SdkDomain } = await import("@larksuiteoapi/node-sdk");
  return new Client({
    appId: material.appId,
    appSecret: material.appSecret,
    domain: material.domain === "lark" ? SdkDomain.Lark : SdkDomain.Feishu,
    logger: silentSdkLogger,
  });
}

/** Default bot-name read: `GET /open-apis/bot/v3/info` through the SDK client,
 *  which mints the tenant access token it needs. */
async function fetchFeishuBotName(
  material: FeishuPendingMaterial,
  signal: AbortSignal,
): Promise<string | null> {
  const client = await feishuClient(material);
  const res = await client.request<{ bot?: { app_name?: string } }>({
    method: "GET",
    url: "/open-apis/bot/v3/info",
    signal,
  });
  return res.bot?.app_name?.trim() || null;
}

function feishuAccountDomain(domain: "feishu" | "lark"): string {
  return domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn";
}

/** The scopes/events/callbacks Rome's agent app needs, granted at creation by
 *  the registerApp flow. */
export function feishuRegistrationAddons() {
  return {
    scopes: {
      tenant: [
        "application:bot.basic_info:read",
        "cardkit:card:read",
        "cardkit:card:write",
        "im:chat:read",
        "im:message.group_msg:readonly",
        "im:message.group_at_msg.include_bot:readonly",
        "im:message.group_at_msg:readonly",
        "im:message.p2p_msg:readonly",
        "im:message:readonly",
        "im:message.reactions:write_only",
        "im:message:send_as_bot",
        "im:message:update",
        "application:app_slash_command:read",
        "application:app_slash_command:write",
      ],
    },
    events: { items: { tenant: ["im.message.receive_v1"] } },
    callbacks: { items: ["card.action.trigger"] },
  };
}

/** Default agent-ready dance: the SDK's `registerApp` QR flow. Runs against no
 *  adapter and no prior credential — the scan MINTS the app pair. */
export async function registerFeishuAgentApp(opts: {
  domain: "feishu" | "lark";
  signal: AbortSignal;
  onQrCode: (qr: FeishuAgentReadyQr) => void;
}): Promise<FeishuPendingMaterial> {
  const { registerApp } = await import("@larksuiteoapi/node-sdk");
  let result: Awaited<ReturnType<typeof registerApp>>;
  try {
    result = await registerApp({
      domain: feishuAccountDomain(opts.domain),
      larkDomain: feishuAccountDomain("lark"),
      source: "rome",
      createOnly: true,
      signal: opts.signal,
      appPreset: { name: "Rome", desc: "Rome agent for Feishu/Lark chat." },
      addons: feishuRegistrationAddons(),
      onQRCodeReady(info) {
        const expiresAt = new Date(Date.now() + info.expireIn * 1000).toISOString();
        // QR encoding is best-effort: the url link alone keeps the view complete.
        void import("qrcode").then(
          (QRCode) =>
            QRCode.default
              .toDataURL(info.url)
              .then((qrDataUrl) => opts.onQrCode({ url: info.url, qrDataUrl, expiresAt }))
              .catch(() => opts.onQrCode({ url: info.url, qrDataUrl: null, expiresAt })),
          () => opts.onQrCode({ url: info.url, qrDataUrl: null, expiresAt }),
        );
      },
    });
  } catch (err) {
    // The SDK rejects with `{ description }` shapes; surface a guardian-readable
    // reason (the setup runtime renders it on the failed state).
    if (err && typeof err === "object" && "description" in err) {
      throw new Error(String((err as { description?: unknown }).description));
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
  const domain =
    result.user_info?.tenant_brand === "lark" || opts.domain === "lark" ? "lark" : "feishu";
  return { appId: result.client_id, appSecret: result.client_secret, domain };
}

/** Default LarkChannel factory (mirrors the FeishuAdapter default) parameterized
 *  by the pasted `app` material so `validate` can mint a token from it. */
function defaultCreateChannel(config: FeishuConfig): LarkChannel {
  return createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
    transport: "websocket",
    outbound: { markdownConverter: "builtin" },
    includeRawEvent: true,
    loggerLevel: LoggerLevel.warn,
  });
}

/**
 * Build the Feishu descriptor. Repos + the agent lister are threaded in at
 * registration time; `deps.createChannel` is injectable so the fault-mapping
 * tests can drive a fake LarkChannel without the network.
 */
export function createFeishuDescriptor(deps: FeishuDescriptorDeps): ConnectionDescriptor {
  const createChannel = deps.createChannel ?? defaultCreateChannel;
  const probeCredentials = deps.probeCredentials ?? probeFeishuCredentials;
  const registerAgentApp = deps.registerAgentApp ?? registerFeishuAgentApp;
  const fetchBotName = deps.fetchBotName ?? fetchFeishuBotName;
  const appScheme = credentialsPaste({
    instructions: "Paste your Feishu/Lark custom-app App ID and App Secret.",
    fields: [
      { name: "appId", label: "App ID", secret: false },
      { name: "appSecret", label: "App secret", secret: true },
      { name: "domain", label: "Domain", secret: false, options: ["feishu", "lark"] },
    ],
    // A transient connect mints the tenant-access-token; a bad appId/appSecret
    // rejects here so confer refuses invalid credentials.
    validate: async (material) => {
      const channel = createChannel({
        appId: material.appId,
        appSecret: material.appSecret,
        domain: material.domain === "lark" ? "lark" : "feishu",
      });
      try {
        await channel.connect();
      } finally {
        await channel.disconnect().catch(() => {});
      }
    },
  });
  // The Feishu conferral setup: mode + domain prompt, then either the
  // manual credential probe or the agent-ready registerApp QR dance, then the
  // before the single terminal write of credential and profile.
  appScheme.setup = makeFeishuSetup({
    probeCredentials,
    registerAgentApp,
    fetchBotName,
  });

  return {
    service: "feishu",
    reviveProfile: (_grant, record) => reviveFeishuProfile(record),
    auth: {
      app: appScheme,
    },
    capabilities: {
      talker: {
        needs: ["app"] as const,
        build(creds, kit): Talker {
          // Inline material for the `app` grant (never an external resolver for
          // a Talk grant); credentialsPaste packs these fields.
          const app = creds.app.material as unknown as FeishuAppMaterial;
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          const routeFault = (err: unknown): void => {
            faultSink?.(
              isFeishuAuthError(err)
                ? new CredentialRejected({ grant: "app", cause: err })
                : new Disconnected(err),
            );
          };

          const config: FeishuConfig = {
            appId: app.appId,
            appSecret: app.appSecret,
            domain: app.domain,
            connectionId: kit.connectionId,
            conversationSettings: deps.conversationSettings,
            personMappingRepo: deps.personMappingRepo,
            listAgents: deps.listAgents,
            onFault: routeFault,
          };
          const adapter = new FeishuAdapter(config, createChannel);

          const activity: ChannelActivity = {
            async begin(input) {
              if (!input.messageId) return null;
              const messageId = input.messageId;
              const reactionId = await adapter.addProcessingReaction(messageId);
              if (!reactionId) return null;
              return {
                update: async () => {},
                finish: async () => adapter.removeProcessingReaction(messageId, reactionId),
              };
            },
          };
          const directory: TalkDirectory = {
            async listConversations(input) {
              const query = input.query?.toLocaleLowerCase();
              const page = directoryPage(
                adapter
                  .listObservedConversations()
                  .filter(
                    (conversation) =>
                      !query || conversation.displayName.toLocaleLowerCase().includes(query),
                  )
                  .sort((left, right) =>
                    `${left.displayName}\0${left.id}`.localeCompare(
                      `${right.displayName}\0${right.id}`,
                    ),
                  ),
                input,
              );
              return {
                conversations: page.items.map((conversation) => ({
                  ref: {
                    connectionId: kit.connectionId,
                    conversationId:
                      conversation.id as import("@rome-os/app-runtime").ConversationId,
                  },
                  service: "feishu",
                  kind: conversation.kind,
                  displayName: conversation.displayName,
                })),
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              };
            },
          };
          const features: TalkFeatures = {
            directMessaging: addressIsConversationFeature(),
            activity,
            directory,
          };
          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onInbound(async (msg) => deliver(msg));
              // start() awaits channel.connect(), which rejects on bad
              // credentials, so a refused `app` grant surfaces here; ongoing
              // long-connection errors route through the adapter's onFault seam.
              adapter.start().catch(routeFault);
            },
            stop(): Promise<void> {
              return adapter.stop();
            },
            async send(conversationId, msg) {
              try {
                return await adapter.send(conversationId, msg);
              } catch (err) {
                // A tenant-access-token failure from send is a refused credential.
                if (isFeishuAuthError(err)) {
                  throw new CredentialRejected({ grant: "app", cause: err });
                }
                throw err;
              }
            },
            ...features,
          };
        },
      },
    },
  };
}

// Re-exported so tests can build canned inbound/card events against the same
// SDK shapes the adapter consumes.
export type { CardActionEvent, LarkChannel, LarkMessage };
