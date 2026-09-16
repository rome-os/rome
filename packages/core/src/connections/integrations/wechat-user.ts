// WeChat user-account (personal) connection integration. Channel contract:
// docs/architecture/channels.md.
//
// Unlike the bot channel (integrations/wechat.ts), this is the guardian's own
// WeChat account, read through the official desktop client running in this Rome
// container. The single `session` grant is custody-external in LinkedIn's
// sense: what proves the account is the signed-in client plus the recovered
// store key, both of which live in the container. Rome's ledger records a
// custody marker and the account identity, never the key — the key unlocks a
// whole personal archive, and is not something Rome takes into its own custody.
//
// The connection is READ-ONLY. `send` throws, `directMessaging` answers null,
// and nothing is delivered into the agent pipeline: a personal account's whole
// history arriving as inbound turns would put an agent in the middle of every
// conversation the guardian has ever had. The read surfaces are `directory`
// (which chats exist) and `history` (what was said), both live queries against
// the client's own store.
//
// Conferral is observational and physical. The guardian opens Rome's desktop,
// scans the QR with their phone, and confirms the login there — the same
// desktop surface LinkedIn's setup uses. Recovering the store key needs ptrace
// on the live client, which this container cannot do, so that one step runs as
// a root script on the hosting VM (channels/wechat-user-keys.ts) and hands back
// only the passphrase; Rome derives the per-database keys back here.
//
// Fault mapping: a reader that reports the account signed out, or a key that no
// longer fits, is terminal (CredentialRejected → the grant degrades → the
// guardian reconnects). A reader that merely fails to run is runtime
// degradation, not a revoked login.

import { z } from "zod";
import { rm } from "node:fs/promises";
import type {
  ConversationDescriptor,
  ConversationId,
  InboundMessage,
  TalkDirectory,
  TalkFeatureMap,
  TalkFeatureName,
  TalkHistory,
} from "@rome-os/app-runtime";
import {
  isWechatUserSessionRejected,
  WechatUserReader,
  WechatUserRuntime,
  WechatUserStorePending,
  type WechatUserConversation,
  type WechatUserMessage,
  type WechatUserStatus,
} from "../../channels/wechat-user.js";
import { recoverWechatPassphrase, stageCaptureDriver } from "../../channels/wechat-user-keys.js";
import type { RootScriptRunner } from "../../host-execution/root-script-runner.js";
import { createLogger } from "../../logger.js";
import { CredentialRejected } from "../errors.js";
import { abortableDelay, SetupAbortError } from "../setup/session.js";
import type { SetupFn, SetupView } from "../setup/types.js";
import type {
  AuthScheme,
  CapabilityDegradation,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  Talker,
} from "../types.js";
import { directoryPage, historyQueryLimit } from "./talk-features.js";

const log = createLogger("wechat-user");

export const WECHAT_USER_SERVICE = "wechat_user";

/** How long a setup step waits for the guardian's phone actions. Scanning and
 *  confirming on a phone that may be in another room: generous on purpose. */
const LOGIN_WAIT_TIMEOUT_MS = 10 * 60_000;
const STATUS_POLL_INTERVAL_MS = 3_000;
/** How often the scan step re-screenshots the login window into the view. The
 *  QR is a static image the guardian photographs, so it need not be fast. */
const QR_POLL_INTERVAL_MS = 3_000;
/** Liveness cadence for a live epoch. A personal account is read on demand, so
 *  this only needs to notice a dead session before the guardian does. */
const SESSION_PROBE_INTERVAL_MS = 5 * 60_000;

// ── Grant profile ─────────────────────────────────────────────────────────

export const wechatUserGrantProfileSchema = z
  .object({
    /** The account's WeChat id — the directory name its store lives under. */
    wxid: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    /** ISO timestamp the login was observed (owner-side). */
    connectedAt: z.string().min(1).optional(),
  })
  .strict();
export type WechatUserGrantProfile = z.infer<typeof wechatUserGrantProfileSchema>;

export function toWechatUserDisplay(profile: WechatUserGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    handle: profile.wxid,
    email: undefined,
    avatarUrl: undefined,
  });
}

export function reviveWechatUserProfile(record: ProfileRecord): ProfileDisplay {
  return toWechatUserDisplay(wechatUserGrantProfileSchema.parse(record));
}

export function wechatUserProfileFromStatus(
  status: WechatUserStatus,
  connectedAt: Date,
): WechatUserGrantProfile | null {
  if (!status.wxid) return null;
  return wechatUserGrantProfileSchema.parse({
    wxid: status.wxid,
    connectedAt: connectedAt.toISOString(),
  });
}

// ── auth scheme ───────────────────────────────────────────────────────────

/** The custody marker the ledger stores in place of a secret. The store key
 *  never enters the ledger; this records where the authority lives. */
function containerCredential(wxid: string | undefined): Credential {
  return {
    material: { custody: "rome-container", ...(wxid ? { wxid } : {}) },
    expiresAt: "never",
  };
}

/**
 * The `session` scheme. Conferral is the setup below. renew() re-reads the
 * account: still signed in with a working key keeps the credential; a definite
 * signed-out or bad-key answer is the only thing that demands reconnecting. A
 * reader that merely fails to run keeps the credential — the client may be
 * restarting, and a genuinely dead session re-faults on the next probe.
 */
export function wechatUserSessionScheme(reader: WechatUserReader): AuthScheme {
  return {
    async confer(): Promise<Credential> {
      throw new Error("conferral driven by the connection setup");
    },
    async renew(cred: Credential): Promise<Credential | "re-confer"> {
      try {
        await reader.conversations({ limit: 1 });
        return cred;
      } catch (error) {
        return isWechatUserSessionRejected(error) ? "re-confer" : cred;
      }
    },
  };
}

// ── conferral setup ─────────────────────────────────────────────────────────

function installingView(): SetupView {
  return {
    title: "Preparing WeChat",
    body: [
      "Setting up the WeChat client on your instance. This runs once and takes a few minutes.",
    ],
    progress: true,
  };
}

function scanView(qr?: string): SetupView {
  if (qr) {
    return {
      title: "Scan with WeChat",
      body: [
        "Open WeChat on your phone and scan this code to sign in — the same way you would on a new computer.",
      ],
      qr,
      steps: [
        { text: "Scan the QR code with WeChat on your phone" },
        { text: "Confirm the sign-in on your phone" },
      ],
      progress: true,
    };
  }
  return {
    title: "Scan with WeChat",
    body: [
      "Rome is bringing up the WeChat login on your instance. The QR code will appear here in a moment — if it does not, open Rome's desktop and sign in there.",
    ],
    links: [{ label: "Open Rome's desktop", url: "/desktop" }],
    steps: [
      { text: "Wait for the WeChat login QR to appear" },
      { text: "Scan the QR code with WeChat on your phone" },
      { text: "Confirm the sign-in on your phone" },
    ],
    progress: true,
  };
}

/** A cached account opens a sign-in button, not a QR. A screenshot of that
 *  button cannot be clicked from here, so the guardian signs in on the desktop. */
function rememberedView(): SetupView {
  return {
    title: "Sign in to WeChat",
    body: [
      "WeChat remembers this account on your instance, so it asks you to sign in instead of showing a QR code. Open Rome's desktop, select the sign-in button in the WeChat window, then confirm on your phone.",
    ],
    links: [{ label: "Open Rome's desktop", url: "/desktop" }],
    steps: [
      { text: "Open Rome's desktop" },
      { text: "Select the sign-in button in the WeChat window" },
      { text: "Confirm the sign-in on your phone" },
    ],
    progress: true,
  };
}

function keysView(remembered: boolean): SetupView {
  return {
    title: "Unlocking your message history",
    body: [
      "WeChat keeps your history encrypted and only unlocks it while it signs in. Rome is recovering that key now — this can take a minute.",
      "If the desktop shows a sign-in confirmation, approve it on your phone.",
    ],
    links: [{ label: "Open Rome's desktop", url: "/desktop" }],
    steps: [
      {
        text: remembered ? "Sign in on Rome's desktop" : "Scan the QR code with WeChat",
        done: true,
      },
      { text: "Confirm the sign-in on your phone", done: true },
      { text: "Rome unlocks your message history" },
    ],
    progress: true,
  };
}

export interface WechatUserSetupDeps {
  runtime: WechatUserRuntime;
  /** Recover the store passphrase (the root script). Injectable for tests;
   *  production wires the action-driven runner. It launches the client under gdb
   *  and blocks until a login derives the key, so the caller shows the scan
   *  walkthrough alongside it rather than waiting for a login first. */
  recoverPassphrase: (signal: AbortSignal) => Promise<string>;
  /** Stage the capture driver inside this container before recovery runs. */
  stageDriver: () => Promise<void>;
  ensureRecoveryAvailable?: () => void;
  pollIntervalMs?: number;
  loginTimeoutMs?: number;
  /** How often to re-screenshot the login window into the scan view. */
  qrPollIntervalMs?: number;
}

/**
 * Build the WeChat user-account conferral setup. A linear coroutine:
 *   1. `ensure-runtime` — install the client and reader if absent, bring up the
 *      session the client draws into, and stage the capture driver (an
 *      already-ready account confers immediately). The client is not started
 *      here; recovery launches it under gdb to catch the first login's key.
 *   2. `capture-login` — recover the store passphrase via the hosting VM root
 *      script, which launches the client so the QR appears; stream that QR into
 *      the view while the guardian signs in, then derive and verify the
 *      per-database keys in the container and wait until the store reads
 *      unlocked,
 *   3. return the terminal conferral: custody marker + account identity.
 * Nothing durable exists before the terminal return. Cancelling writes nothing;
 * the only state left behind is the client's own session, which the guardian
 * can sign out of from their phone.
 */
export function makeWechatUserSetup(deps: WechatUserSetupDeps): SetupFn {
  const pollIntervalMs = deps.pollIntervalMs ?? STATUS_POLL_INTERVAL_MS;
  const loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_WAIT_TIMEOUT_MS;
  const qrPollIntervalMs = deps.qrPollIntervalMs ?? QR_POLL_INTERVAL_MS;
  const { runtime } = deps;

  const waitFor = async (
    signal: AbortSignal,
    done: (status: WechatUserStatus) => boolean,
  ): Promise<WechatUserStatus> => {
    const deadline = Date.now() + loginTimeoutMs;
    for (;;) {
      if (signal.aborted) throw new SetupAbortError();
      const status = await runtime.status();
      if (done(status)) return status;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for WeChat. Start the setup again.");
      }
      await abortableDelay(pollIntervalMs, signal);
    }
  };

  return async (interact, ctx) => {
    const ready = await ctx.step("ensure-runtime", async (signal) => {
      const initial = await runtime.status();
      if (initial.state === "ready" && initial.running) return initial;
      if (initial.keysReady) {
        interact.show({
          title: "Resuming WeChat",
          body: [
            "Open the desktop and confirm the sign-in on your phone if WeChat asks. Your saved message keys are ready.",
          ],
          links: [{ label: "Open Rome's desktop", url: "/desktop" }],
          progress: true,
        });
        await runtime.start(signal);
        return waitFor(signal, (status) => status.running && status.state === "ready");
      }
      deps.ensureRecoveryAvailable?.();
      if (!initial.installed) {
        interact.show(installingView());
        await runtime.install(signal);
      }
      await runtime.installReader(signal);
      // The client is deliberately not started here — recovery launches it under
      // gdb to own it from birth and catch the first login. Only the session it
      // draws into and the capture driver are readied.
      await runtime.prepareSession();
      await deps.stageDriver();
      return null;
    });

    let status = ready;
    if (!status) {
      status = await ctx.step("capture-login", async (signal) => {
        // Recovery launches the client, so the login window appears once this
        // begins. While recovery waits for the guardian to sign in, poll that
        // window and stream it into the view as the scannable QR, so the
        // guardian scans inside Rome rather than opening the desktop. The
        // passphrase comes back the moment that first login derives the key.
        // A cached account store makes the client show a sign-in button, which
        // needs the desktop, so that case skips the QR stream.
        const remembered = (await runtime.status()).loggedIn;
        interact.show(remembered ? rememberedView() : scanView());
        const recovery = deps.recoverPassphrase(signal);
        const qr = { stop: remembered };
        const qrLoop = (async () => {
          let last: string | undefined;
          while (!qr.stop && !signal.aborted) {
            const shot = await runtime.captureLoginQr().catch(() => null);
            if (shot && shot !== last) {
              last = shot;
              interact.show(scanView(shot));
            }
            await abortableDelay(qrPollIntervalMs, signal).catch(() => {});
          }
        })();
        try {
          const passphrase = await recovery;
          qr.stop = true;
          await qrLoop;
          interact.show(keysView(remembered));
          await waitFor(signal, (s) => s.loggedIn);
          // Derive and verify the per-database keys from the captured passphrase.
          const deadline = Date.now() + loginTimeoutMs;
          for (;;) {
            try {
              await runtime.readerCommand(["derive", "--passphrase", passphrase], signal);
              break;
            } catch (error) {
              if (!(error instanceof WechatUserStorePending) || Date.now() >= deadline) throw error;
              await abortableDelay(pollIntervalMs, signal);
            }
          }
          return waitFor(signal, (s) => s.running && s.state === "ready");
        } catch (error) {
          qr.stop = true;
          await qrLoop.catch(() => {});
          throw error;
        }
      });
    }

    const profile = wechatUserProfileFromStatus(status, new Date()) ?? undefined;
    return {
      credential: containerCredential(status.wxid),
      ...(profile ? { profile } : {}),
      summary: {
        title: "WeChat connected",
        body: [
          `${status.wxid ?? "Your WeChat account"} is signed in on your instance. Rome can now read your chats and message history.`,
          "This connection is read-only — Rome never sends WeChat messages.",
        ],
      },
    };
  };
}

// ── read surfaces ─────────────────────────────────────────────────────────

function toConversationDescriptor(
  connectionId: string,
  conversation: WechatUserConversation,
): ConversationDescriptor {
  return {
    ref: { connectionId, conversationId: conversation.id as ConversationId },
    service: WECHAT_USER_SERVICE,
    kind: conversation.isGroup ? "group" : "dm",
    displayName: conversation.name || conversation.id,
  };
}

/**
 * Project a reader message onto Talk's provider-neutral shape. `senderId`
 * falls back to the conversation for an authorless system notice, because an
 * empty sender reads downstream as an unknown person rather than as the chat.
 */
export function toWechatUserInboundMessage(message: WechatUserMessage): InboundMessage {
  return {
    messageId: message.id,
    conversationId: message.conversationId as ConversationId,
    senderId: message.senderId || message.conversationId,
    ...(message.senderName ? { senderDisplayName: message.senderName } : {}),
    text: message.text,
    attachments: [],
    timestamp: new Date(message.timestamp * 1000),
    thread: {
      kind: message.isGroup ? "group" : "dm",
      ...(message.conversationName ? { name: message.conversationName } : {}),
    },
    raw: message,
  };
}

// ── descriptor ────────────────────────────────────────────────────────────

export interface WechatUserDescriptorDeps {
  /** How host-root scripts run — the action-driven runner in production. The
   *  key recovery is the only thing that needs it, and it may be absent when
   *  host execution is disabled, in which case connecting fails before installation
   *  rather than at registration. */
  rootScriptRunner?: RootScriptRunner;
  /** Injectable client runtime (tests). */
  runtime?: WechatUserRuntime;
  pollIntervalMs?: number;
  probeIntervalMs?: number;
}

interface WechatUserTalker extends Talker {
  getRuntimeDegradation(): CapabilityDegradation | null;
}

export function createWechatUserDescriptor(
  deps: WechatUserDescriptorDeps = {},
): ConnectionDescriptor {
  const runtime = deps.runtime ?? new WechatUserRuntime();
  const reader = new WechatUserReader(runtime);

  const ensureRecoveryAvailable = () => {
    if (!deps.rootScriptRunner) {
      throw new Error(
        "Host execution is not enabled on this instance, so Rome cannot recover the WeChat message-store key.",
      );
    }
  };
  const recoverPassphrase = async (signal: AbortSignal): Promise<string> => {
    ensureRecoveryAvailable();
    const driverDir = await stageCaptureDriver();
    try {
      return await recoverWechatPassphrase(
        deps.rootScriptRunner!,
        { anchorPid: process.pid, driverDir, home: runtime.home },
        signal,
      );
    } finally {
      await rm(driverDir, { recursive: true, force: true });
    }
  };

  const sessionScheme = wechatUserSessionScheme(reader);
  sessionScheme.setup = makeWechatUserSetup({
    runtime,
    recoverPassphrase,
    ensureRecoveryAvailable,
    stageDriver: async () => {},
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
  });

  return {
    service: WECHAT_USER_SERVICE,
    reviveProfile: (_grant, record) => reviveWechatUserProfile(record),
    auth: {
      session: sessionScheme,
    },
    capabilities: {
      talker: {
        needs: ["session"] as const,
        build(_creds, kit): Talker {
          let degradation: CapabilityDegradation | null = null;
          let probe: ReturnType<typeof setTimeout> | null = null;
          let controller: AbortController | null = null;
          let pending: Promise<void> | null = null;

          const directory: TalkDirectory = {
            async listConversations(input) {
              // The reader ranks by recency and has no native cursor, so a page
              // is taken locally over a bounded fetch — the same bargain the
              // other in-memory directories make.
              const fetched = await reader.conversations({
                ...(input.query ? { query: input.query } : {}),
                limit: Math.min(Math.max(input.limit, 1) * 4, 500),
              });
              const page = directoryPage(fetched, input);
              return {
                conversations: page.items.map((conversation) =>
                  toConversationDescriptor(kit.connectionId, conversation),
                ),
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              };
            },
          };

          const history: TalkHistory = {
            async query(input) {
              const messages = await reader.messages({
                ...(input.conversationId ? { conversationId: input.conversationId } : {}),
                ...(input.since ? { since: input.since } : {}),
                limit: historyQueryLimit(input.limit),
              });
              return messages.map(toWechatUserInboundMessage);
            },
          };

          const talker: WechatUserTalker = {
            // Read-only: nothing is delivered into the agent pipeline, so
            // `deliver` stays unused. History is answered on demand, never pushed.
            start(_deliver, fault): void {
              if (controller) return;
              const epoch = new AbortController();
              controller = epoch;
              degradation = { reason: "Rome is checking the WeChat desktop session." };
              // Each epoch runs one probe at a time. stop() aborts pending work
              // so stale probes cannot publish health or launch another client.
              const tick = async (): Promise<void> => {
                try {
                  let status = await runtime.status();
                  if (epoch.signal.aborted) return;
                  if (status.installed && !status.running) {
                    degradation = {
                      reason:
                        "The WeChat desktop client is stopped. Rome is restarting it; saved history remains readable.",
                    };
                    await runtime.start(epoch.signal);
                    if (epoch.signal.aborted) return;
                    status = await runtime.status();
                  }
                  if (epoch.signal.aborted) return;
                  if (!status.running) {
                    degradation = {
                      reason:
                        "The WeChat desktop client is not running. New messages cannot sync. Rome will retry.",
                    };
                  } else if (status.state === "awaiting-scan" && !status.loggedIn) {
                    degradation = { reason: "The WeChat account is signed out on your instance." };
                    fault(
                      new CredentialRejected({
                        grant: "session",
                        cause: new Error("WeChat signed out"),
                      }),
                    );
                  } else if (status.state === "awaiting-scan") {
                    degradation = {
                      reason:
                        "WeChat needs sign-in confirmation. Open Rome's desktop and confirm on your phone if asked. Saved history remains available.",
                    };
                  } else if (status.state === "ready") {
                    degradation = null;
                  } else {
                    degradation = { reason: "The WeChat message store is not ready." };
                  }
                } catch (error) {
                  if (epoch.signal.aborted) return;
                  degradation = {
                    reason: `Rome cannot resume the WeChat client: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  };
                  log.warn("wechat_user.probe_failed", {
                    error: error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  if (!epoch.signal.aborted) {
                    probe = setTimeout(() => {
                      pending = tick();
                    }, deps.probeIntervalMs ?? SESSION_PROBE_INTERVAL_MS);
                    probe.unref?.();
                  }
                }
              };
              pending = tick();
            },
            async stop(): Promise<void> {
              controller?.abort();
              if (probe) clearTimeout(probe);
              probe = null;
              await pending;
              pending = null;
              controller = null;
            },
            async send(): Promise<never> {
              throw new Error("The WeChat personal connection is read-only");
            },
            feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
              // `directMessaging` is absent on purpose: answering null is the
              // whole declaration that this channel cannot be written to.
              const features: Partial<TalkFeatureMap> = { directory, history };
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
            getRuntimeDegradation(): CapabilityDegradation | null {
              return degradation;
            },
          };
          return talker;
        },
        degradation(instance: Talker): CapabilityDegradation | null {
          return (instance as WechatUserTalker).getRuntimeDegradation();
        },
      },
    },
  };
}
