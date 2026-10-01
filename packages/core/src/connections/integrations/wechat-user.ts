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
// conversation the guardian has ever had. The Talk's read surface is `directory`
// (which chats exist), a live query against the client's own store. What was
// said is the channel's `messages` (wechat-user-messages.ts), read the same way.
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
  TalkDirectory,
  TalkFeatureMap,
  TalkFeatureName,
} from "@rome-os/app-runtime";
import {
  isWechatUserSessionRejected,
  WechatUserReader,
  WechatUserRuntime,
  WechatUserStorePending,
  type WechatUserConversation,
  type WechatUserStatus,
} from "../../channels/wechat-user.js";
import { recoverWechatPassphrase, stageCaptureDriver } from "../../channels/wechat-user-keys.js";
import { WECHAT_USER_CHANNEL } from "../../channels/wechat-user-messages.js";
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
import { directoryPage } from "./talk-features.js";

const log = createLogger("wechat-user");

// The channel's name is the service's: one constant, so the channel its reads
// back and the channel its Connection backs cannot drift into two.
export const WECHAT_USER_SERVICE = WECHAT_USER_CHANNEL;

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

function scanView(desktop: string, qr?: string): SetupView {
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
    links: [{ label: "Open Rome's desktop", url: desktop }],
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
function rememberedView(desktop: string): SetupView {
  return {
    title: "Sign in to WeChat",
    body: [
      "WeChat remembers this account on your instance, so it asks you to sign in instead of showing a QR code. Open Rome's desktop, select the sign-in button in the WeChat window, then confirm on your phone.",
    ],
    links: [{ label: "Open Rome's desktop", url: desktop }],
    steps: [
      { text: "Open Rome's desktop" },
      { text: "Select the sign-in button in the WeChat window" },
      { text: "Confirm the sign-in on your phone" },
    ],
    progress: true,
  };
}

function keysView(remembered: boolean, desktop: string): SetupView {
  return {
    title: "Unlocking your message history",
    body: [
      "WeChat keeps your history encrypted and only unlocks it while it signs in. Rome is recovering that key now — this can take a minute.",
      "If the desktop shows a sign-in confirmation, approve it on your phone.",
    ],
    links: [{ label: "Open Rome's desktop", url: desktop }],
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
  /** Recover the store passphrase. Injectable for tests. It launches the client
   *  under gdb in this container and blocks until a login derives the key, so the
   *  caller shows the scan walkthrough alongside it rather than waiting for a
   *  login first. */
  /** Launches the client on `display` and returns its store passphrase. */
  recoverPassphrase: (signal: AbortSignal, display: string) => Promise<string>;
  /** Stage the capture driver inside this container before recovery runs. */
  stageDriver: () => Promise<void>;
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
    // The capture lease, once the setup takes the capture path. Released when
    // the setup ends, whether it confers, fails or is cancelled.
    const lease: { release?: () => void } = {};
    const confer = async () => {
      const ready = await ctx.step("ensure-runtime", async (signal) => {
        const initial = await runtime.status();
        if (initial.state === "ready" && initial.running) return initial;
        if (initial.keysReady) {
          interact.show({
            title: "Resuming WeChat",
            body: [
              "Open the desktop and confirm the sign-in on your phone if WeChat asks. Your saved message keys are ready.",
            ],
            links: [{ label: "Open Rome's desktop", url: initial.desktopPath }],
            progress: true,
          });
          await runtime.start(signal);
          return waitFor(signal, (status) => status.running && status.state === "ready");
        }
        // From here the setup owns the client until its key capture ends: the
        // capture kills any client and relaunches it under a debugger, so nothing,
        // such as an open /desktop/wechat, may launch an ordinary one meanwhile.
        lease.release ??= runtime.holdCapture();
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
          // Held already when the first step took the capture path; taken
          // here when this step runs on its own.
          lease.release ??= runtime.holdCapture();
          // Recovery launches the client, so the login window appears once this
          // begins. While recovery waits for the guardian to sign in, poll that
          // window and stream it into the view as the scannable QR, so the
          // guardian scans inside Rome rather than opening the desktop. The
          // passphrase comes back the moment that first login derives the key.
          // A cached account store makes the client show a sign-in button, which
          // needs the desktop, so that case skips the QR stream.
          const remembered = (await runtime.status()).loggedIn;
          // Recovery replaces any running client, so it starts on WeChat's own
          // desktop. Recovery, the QR capture and the links all use the display
          // this returns, never a legacy client's that a status() reports.
          const display = await runtime.ensureDesktop(signal);
          const desktopPath = runtime.desktopPathFor(display);
          interact.show(remembered ? rememberedView(desktopPath) : scanView(desktopPath));
          const recovery = deps.recoverPassphrase(signal, display);
          const qr = { stop: remembered };
          const qrLoop = (async () => {
            let last: string | undefined;
            while (!qr.stop && !signal.aborted) {
              const shot = await runtime.captureLoginQr(display).catch(() => null);
              if (shot && shot !== last) {
                last = shot;
                interact.show(scanView(desktopPath, shot));
              }
              await abortableDelay(qrPollIntervalMs, signal).catch(() => {});
            }
          })();
          try {
            const passphrase = await recovery;
            qr.stop = true;
            await qrLoop;
            interact.show(keysView(remembered, desktopPath));
            await waitFor(signal, (s) => s.loggedIn);
            // Derive and verify the per-database keys from the captured passphrase.
            const deadline = Date.now() + loginTimeoutMs;
            for (;;) {
              try {
                await runtime.readerCommand(["derive", "--passphrase", passphrase], signal);
                break;
              } catch (error) {
                if (!(error instanceof WechatUserStorePending) || Date.now() >= deadline)
                  throw error;
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
    try {
      return await confer();
    } finally {
      lease.release?.();
    }
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

// ── descriptor ────────────────────────────────────────────────────────────

export interface WechatUserDescriptorDeps {
  /** The client runtime. Boot passes the one the channel list reads through,
   *  so the channel and this Connection coordinate one client; built here when
   *  absent (tests). The reader is a stateless wrapper over it. */
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

  const recoverPassphrase = async (signal: AbortSignal, display: string): Promise<string> => {
    const driverDir = await stageCaptureDriver(runtime.runtimeDir);
    try {
      return await recoverWechatPassphrase(
        { driverDir, home: runtime.home, runtimeDir: runtime.runtimeDir, display },
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
        // Read-only: the personal account is consulted, never written to or
        // answered (docs/architecture/channels.md#wechat-personal-account).
        sends: false,
        receives: false,
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
                  const wasRunning = status.running;
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
                  if (wasRunning) {
                    // A client that was already running joins accessibility
                    // live; a restarted one got it from start(). Never throws,
                    // so it cannot degrade a client that reads fine.
                    await runtime.ensureAccessibility();
                    if (epoch.signal.aborted) return;
                    // The desktop outlives any one process on it; restart a part
                    // that died, so the guardian can still reach the client.
                    await runtime.repairDesktop(epoch.signal);
                    if (epoch.signal.aborted) return;
                  }
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
                  } else if (status.state === "ready" && status.movePending) {
                    // It works, but still beside Chrome. Rome never restarts a
                    // live client itself, since that can ask the phone to confirm.
                    degradation = {
                      reason:
                        "WeChat still runs on the shared desktop beside Rome's Chrome. To move it to its own desktop, quit WeChat at /desktop. Rome starts it again within a few minutes at /desktop/wechat, and your phone may ask you to confirm the sign-in.",
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
              const features: Partial<TalkFeatureMap> = { directory };
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
