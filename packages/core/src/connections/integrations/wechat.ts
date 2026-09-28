import { createHash } from "node:crypto";
import { wechatDeliveryProfile } from "./delivery-profiles.js";
import { textDeliveryFeature } from "./text-delivery-feature.js";
// WeChat connection integration. Channel contract: docs/architecture/channels.md.
//
// WeChat is a Talker with a single `account` grant: the bot token + the account
// coordinates (baseUrl, accountId, optional userId) minted by the QR pairing
// flow. The transport core — long-poll, normalization, attachment
// download/decrypt, media send — is the existing `WechatAdapter`
// (packages/core/src/channels/wechat.ts), wrapped here so the runtime's
// grant-epoch lifecycle and fault→grant-state mapping drive it.
//
// The pairing conferral is the setup on the `account` scheme
// (`makeWechatSetup`): the coroutine mints the QR via `WechatAuthService`,
// presents it (`show`), waits for the scan confirm inside `ctx.step`, and
// returns the terminal conferral — the runtime performs the single ledger
// write. The scheme's `confer()` still throws — there is no headless confer
// for WeChat.
//
// Fault mapping: the adapter retries transient getupdates
// failures internally as before; only a refused credential (ilinkai HTTP
// 401/403, `isWechatAuthError`) is terminal and reaches `fault` as
// CredentialRejected{ grant: "account" }. Any other terminal poll failure is a
// Disconnected.

import type { TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import {
  getDefaultWechatStatePath,
  isWechatAuthError,
  WechatAdapter,
  type WechatAdapterConfig,
  WechatAuthService,
  type WechatSettings,
} from "../../channels/wechat.js";
import { z } from "zod";
import { CredentialRejected, Disconnected } from "../errors.js";
import { abortableDelay, SetupAbortError } from "../setup/session.js";
import type { SetupFn, SetupView } from "../setup/types.js";
import type {
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  SecretRecord,
  Talker,
} from "../types.js";
import {
  inboundMediaFeature,
  toInboundMessage,
  toMessageReceipt,
  typingActivityFeature,
} from "./talk-features.js";

/** The `account` grant material — the pairing flow's output (see wechat.ts). */
export interface WechatAccountMaterial {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string | null;
  statePath?: string;
}

/** Build the `account` grant material from a pairing outcome or settings row.
 *  Single source of the material shape for both conferral paths (the setup
 *  and `WECHAT_SETTINGS_IMPORT_ROW`) so they can never drift: token +
 *  account coordinates, accountId duplicated into material,
 *  sparse fields absent, `connectedAt` out. Null when the secrets are missing. */
export function wechatAccountMaterial(source: {
  token?: string;
  baseUrl?: string;
  accountId?: string;
  userId?: string | null;
  statePath?: string;
}): SecretRecord | null {
  if (!source.token || !source.accountId) return null;
  const material: SecretRecord = {
    token: source.token,
    baseUrl: source.baseUrl ?? "https://ilinkai.weixin.qq.com",
    accountId: source.accountId,
  };
  if (source.userId) material.userId = source.userId;
  if (source.statePath) material.statePath = source.statePath;
  return material;
}

// The `account` grant's profile — the non-secret half of the pairing outcome
// (which ilinkai account, and which guardian person it is bound to). Declared
// next to the material shape; parse-then-store, same schema re-runs on revive
// (fail-closed). `accountId` is the sole display field; the bound-guardian
// `userId` stays owner-side. Both optional so a bridge-era grant stays
// sparse-but-valid.
export const wechatGrantProfileSchema = z
  .object({
    accountId: z.string().min(1).optional(),
    /** The guardian person id this account is bound to (owner-side identity). */
    userId: z.string().min(1).optional(),
  })
  .strict();
export type WechatGrantProfile = z.infer<typeof wechatGrantProfileSchema>;

/** Pure display projection: the account id reads as the handle. The bound
 *  guardian `userId` is owner-side and never widens the display surface. */
export function toWechatDisplay(profile: WechatGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: undefined,
    handle: profile.accountId,
    email: undefined,
    avatarUrl: undefined,
  });
}

/** Revive a stored wechat profile: re-parse with the schema, then map through the
 *  pure display function (fail-closed on a record that no longer matches). */
export function reviveWechatProfile(record: ProfileRecord): ProfileDisplay {
  return toWechatDisplay(wechatGrantProfileSchema.parse(record));
}

/** The identity fields the wechat settings row carries (pairing output). */
export interface WechatProfileSource {
  accountId?: string;
  userId?: string | null;
}

/** Build the parsed grant profile from the settings row, or null when the row
 *  carries no identity to record. */
export function wechatProfileFromSettings(
  settings: WechatProfileSource,
): WechatGrantProfile | null {
  const raw: Record<string, unknown> = {};
  if (settings.accountId != null && settings.accountId !== "") raw.accountId = settings.accountId;
  if (settings.userId != null && settings.userId !== "") raw.userId = settings.userId;
  if (Object.keys(raw).length === 0) return null;
  return wechatGrantProfileSchema.parse(raw);
}

/**
 * The WeChat adapter factory, injectable for tests. Production constructs a real
 * `WechatAdapter`; the fault-mapping tests inject a fake that drives the fault
 * seam without hitting ilinkai.
 */
export type CreateWechatAdapter = (config: WechatAdapterConfig) => WechatAdapter;

/** The QR-login machinery the setup drives — the surface of
 *  `WechatAuthService`, declared narrowly so tests inject a scripted fake
 *  (no ilinkai, no network). */
export interface WechatLoginService {
  startLogin(
    baseUrl?: string,
  ): Promise<{ attemptId: string; qrContent: string; expiresAt: string }>;
  pollLogin(
    attemptId: string,
  ): Promise<
    { status: "wait" | "scaned" | "expired" } | { status: "confirmed"; account: WechatSettings }
  >;
  completeLogin(attemptId: string): void;
}

export interface WechatDescriptorDeps {
  createAdapter?: CreateWechatAdapter;
  /** Injectable QR-login service for the setup; production constructs a
   *  real `WechatAuthService`. */
  auth?: WechatLoginService;
  /** Injectable QR renderer (content → `data:` image URL); production uses the
   *  `qrcode` package. */
  makeQrDataUrl?: (content: string) => Promise<string>;
  /** Scan-poll cadence inside the setup's `scan-confirmed` step. */
  pollIntervalMs?: number;
}

/** Fresh QR attempts a single setup will mint before giving up (each ilinkai
 *  QR lives ~8 minutes, so this bounds an abandoned tab at well under an hour
 *  of provider polling instead of refreshing forever). */
const WECHAT_QR_ATTEMPT_LIMIT = 5;

const DEFAULT_SCAN_POLL_INTERVAL_MS = 2000;

/** Render the QR view the setup presents. One shape for both flavors: the
 *  scanned repaint marks the scan step done and swaps the prompt copy. */
function wechatQrView(qr: string, qrContent: string, scanned: boolean): SetupView {
  return {
    title: "Scan with WeChat",
    body: [
      scanned
        ? "Scanned. Confirm the login on your phone."
        : "Open WeChat on your phone, scan the QR code, then confirm the login.",
    ],
    qr,
    links: [{ label: "Open QR link", url: qrContent }],
    steps: [
      scanned
        ? { text: "Scan the QR code with WeChat", done: true }
        : { text: "Scan the QR code with WeChat" },
      { text: "Confirm the login on your phone" },
    ],
    progress: true,
  };
}

/**
 * Build the WeChat conferral setup. A linear coroutine:
 *   1. mint a QR login attempt (ilinkai),
 *   2. `show` the QR (server-rendered `data:` image + raw open link),
 *   3. `ctx.step("scan-confirmed", …)` — poll the login until the guardian's
 *      scan is confirmed (a `scaned` report repaints the view with the scan
 *      step done); an expired QR loops back to 1 (refresh via repeated `show`),
 *   4. return the terminal conferral: the account credential (material built by
 *      `wechatAccountMaterial`, shared with `WECHAT_SETTINGS_IMPORT_ROW`) +
 *      wechat profile + the bound guardian identity when the login carries one.
 * The runtime performs the single durable write from the returned conferral;
 * abandoning at the QR (or cancelling) leaves zero durable state.
 */
export function makeWechatSetup(deps: {
  auth: WechatLoginService;
  makeQrDataUrl: (content: string) => Promise<string>;
  pollIntervalMs?: number;
}): SetupFn {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_SCAN_POLL_INTERVAL_MS;
  return async (interact, ctx) => {
    for (let attempt = 0; attempt < WECHAT_QR_ATTEMPT_LIMIT; attempt++) {
      const login = await deps.auth.startLogin();
      const qr = await deps.makeQrDataUrl(login.qrContent);
      // Repeated `show` IS the QR refresh: each expired attempt replaces the
      // presented view with a fresh QR.
      interact.show(wechatQrView(qr, login.qrContent, false));

      const account = await ctx.step("scan-confirmed", async (signal) => {
        let scanned = false;
        for (;;) {
          const result = await deps.auth.pollLogin(login.attemptId);
          if (signal.aborted) throw new SetupAbortError();
          if (result.status === "confirmed") return result.account;
          if (result.status === "expired") return null;
          if (result.status === "scaned" && !scanned) {
            scanned = true;
            interact.show(wechatQrView(qr, login.qrContent, true));
          }
          await abortableDelay(pollIntervalMs, signal);
        }
      });
      if (!account) continue;

      // The confirmed account now lives in this coroutine; the attempt cache
      // (the route era's conferral-retry seam) has nothing left to protect.
      deps.auth.completeLogin(login.attemptId);

      const material = wechatAccountMaterial(account);
      if (!material) throw new Error("WeChat login returned an incomplete account.");

      return {
        credential: { material, expiresAt: "never" },
        profile: wechatProfileFromSettings(account) ?? undefined,
        guardianChannelUserId: account.userId ?? undefined,
        summary: {
          title: "WeChat connected",
          body: [`Account ${account.accountId} is live and receiving WeChat messages.`],
        },
      };
    }
    throw new Error("WeChat QR login expired. Start the setup again.");
  };
}

/** Default QR renderer: the `qrcode` package, imported lazily (only a live
 *  setup ever needs it). */
async function renderQrDataUrl(content: string): Promise<string> {
  const QRCode = await import("qrcode");
  return QRCode.default.toDataURL(content);
}

/**
 * The `account` grant scheme. Conferral is the setup (attached by
 * `createWechatDescriptor`), so `confer` throws; `renew` always answers
 * "re-confer" (a refused token needs a fresh pairing).
 */
function wechatAccountScheme(): AuthScheme {
  return {
    async confer(): Promise<Credential> {
      throw new Error("conferral driven by the connection setup");
    },
    async renew(): Promise<Credential | "re-confer"> {
      return "re-confer";
    },
  };
}

/**
 * Build the WeChat descriptor. `deps.createAdapter` is injectable so tests can
 * drive the adapter's fault seam without the network; `deps.auth` /
 * `deps.makeQrDataUrl` likewise stub the setup's QR machinery.
 */
export function createWechatDescriptor(deps: WechatDescriptorDeps = {}): ConnectionDescriptor {
  const createAdapter: CreateWechatAdapter =
    deps.createAdapter ?? ((config) => new WechatAdapter(config));
  const liveAdapters = new WeakMap<Talker, WechatAdapter>();

  const accountScheme = wechatAccountScheme();
  // The WeChat conferral setup: QR show → scan-confirmed wait →
  // single terminal write of credential + profile + guardian mapping.
  accountScheme.setup = makeWechatSetup({
    auth: deps.auth ?? new WechatAuthService(),
    makeQrDataUrl: deps.makeQrDataUrl ?? renderQrDataUrl,
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
  });

  return {
    service: "wechat",
    reviveProfile: (_grant, record) => reviveWechatProfile(record),
    auth: {
      account: accountScheme,
    },
    capabilities: {
      talker: {
        needs: ["account"] as const,
        build(creds): Talker {
          // Inline material for the `account` grant (never an external
          // resolver for a Talk grant); the pairing flow packs these fields.
          const account = creds.account.material as unknown as WechatAccountMaterial;
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          const routeFault = (err: unknown): void => {
            faultSink?.(
              isWechatAuthError(err)
                ? new CredentialRejected({ grant: "account", cause: err })
                : new Disconnected(err),
            );
          };

          const config: WechatAdapterConfig = {
            token: account.token,
            baseUrl: account.baseUrl,
            accountId: account.accountId,
            userId: account.userId ?? null,
            connectedAt: new Date().toISOString(),
            statePath: account.statePath ?? getDefaultWechatStatePath(),
            onFault: routeFault,
          } satisfies WechatAdapterConfig;

          const adapter = createAdapter(config);

          const talker: Talker = {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onMessage(async (msg) => deliver(toInboundMessage(msg)));
              // start() kicks off the long-poll; terminal poll failures route
              // through onFault → routeFault. start() itself only reads local
              // state, so it does not reject on a bad token — that surfaces from
              // the poll loop as an auth fault.
              adapter.start().catch(routeFault);
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
              const features: Partial<TalkFeatureMap> = {
                textDelivery: textDeliveryFeature(
                  wechatDeliveryProfile(
                    "wechat:" + createHash("sha256").update(account.accountId).digest("hex"),
                  ),
                  adapter,
                ),
                inboundMedia: inboundMediaFeature(adapter),
                activity: typingActivityFeature(adapter),
              };
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
          };
          liveAdapters.set(talker, adapter);
          return talker;
        },
        degradation(instance) {
          return liveAdapters.get(instance)?.getRuntimeDegradation() ?? null;
        },
      },
    },
  };
}
