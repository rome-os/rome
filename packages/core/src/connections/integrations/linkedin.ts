// LinkedIn connection integration. Channel contract: docs/architecture/channels.md.
//
// LinkedIn has a single `session` grant, and the grant
// is custody-external: the signed-in session lives in Rome's server-side
// Chrome profile (the one opencli drives over CDP), so the ledger holds only a
// custody marker plus the account identity — there is no secret Rome could
// hold. Conferral is therefore observational: the setup opens the LinkedIn
// login page in the server browser, the guardian signs in through the
// dashboard's /desktop view, and the coroutine polls `opencli linkedin whoami`
// until the session reads authenticated.
//
// The same externality shapes renew(): the session may still be perfectly
// valid in Chrome after a transient auth-shaped failure (LinkedIn checkpoint
// interstitials look like auth walls), so renew re-probes whoami — a healthy
// probe keeps the credential, and only a definite signed-out answer degrades
// to "re-confer".
//
// The inbox poller mirrors history without delivering inbound agent turns.
// Replies use the same browser session and the shared People outbox.

import { z } from "zod";
import type {
  ConversationId,
  NormalizedMessage,
  TalkFeatureMap,
  TalkFeatureName,
} from "@rome-os/app-runtime";
import {
  OpencliAuthError,
  openLinkedInBrowserTab,
  parseWhoami,
  parseLinkedInReply,
  runOpencli,
  type LinkedInWhoami,
  type RunOpencli,
} from "../../channels/linkedin-cli.js";
import { LinkedInInboxPoller } from "../../channels/linkedin.js";
import { linkedInMemberIdFromProfileUrl } from "../../channels/linkedin-sync.js";
import type { LinkedInHistoryMessage, LinkedInSyncSink } from "../../channels/linkedin-sync.js";
import { CredentialRejected } from "../errors.js";
import type { SetupFn } from "../setup/types.js";
import type {
  AuthScheme,
  CapabilityDegradation,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  Talker,
} from "../types.js";
import { historyFeature } from "./talk-features.js";
import { createLogger } from "../../logger.js";

const log = createLogger("linkedin-reply");

const LINKEDIN_LOGIN_URL = "https://www.linkedin.com/login";
const WHOAMI_TIMEOUT_MS = 90_000;
/** How long the setup waits for the guardian to finish signing in. */
const LOGIN_WAIT_TIMEOUT_MS = 10 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 5_000;

// ── Grant profile ─────────────────────────────────────────────────────────
// The non-secret conferral outcome recorded beside the custody marker: who the
// signed-in LinkedIn account is, per `whoami`.

const linkedinGrantProfileSchema = z
  .object({
    /** LinkedIn public id (the `/in/<publicId>` handle). */
    publicId: z.string().min(1).optional(),
    /** LinkedIn numeric member id (owner-side identity). */
    plainId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    /** ISO timestamp the login was observed (owner-side). */
    connectedAt: z.string().min(1).optional(),
  })
  .strict();

export type LinkedInGrantProfile = z.infer<typeof linkedinGrantProfileSchema>;

export function linkedinProfileFromIdentity(
  identity: LinkedInWhoami,
  connectedAt: Date,
): LinkedInGrantProfile | null {
  const raw: LinkedInGrantProfile = {
    ...(identity.publicId ? { publicId: identity.publicId } : {}),
    ...(identity.plainId ? { plainId: identity.plainId } : {}),
    ...(identity.name ? { displayName: identity.name } : {}),
    connectedAt: connectedAt.toISOString(),
  };
  return linkedinGrantProfileSchema.parse(raw);
}

function toLinkedInDisplay(profile: LinkedInGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    handle: profile.publicId,
    email: undefined,
    avatarUrl: undefined,
  });
}

export function reviveLinkedInProfile(record: ProfileRecord): ProfileDisplay {
  return toLinkedInDisplay(linkedinGrantProfileSchema.parse(record));
}

// ── auth scheme ───────────────────────────────────────────────────────────

/** The custody marker the ledger stores in place of a secret. */
function browserSessionCredential(): Credential {
  return { material: { custody: "server-browser" }, expiresAt: "never" };
}

/**
 * The `session` scheme. Conferral is driven by the setup below. renew()
 * re-probes the browser session: still signed in → the credential is still
 * good verbatim; definitely signed out → "re-confer". A transient probe
 * failure (Chrome restarting, CDP briefly unreachable) also keeps the
 * credential — degrading the grant on a probe blip would demand a pointless
 * re-login, and a genuinely dead session re-faults on the next poll tick.
 */
export function linkedinSessionScheme(run: RunOpencli): AuthScheme {
  return {
    async confer(): Promise<Credential> {
      throw new Error("conferral driven by the connection setup");
    },
    async renew(cred: Credential): Promise<Credential | "re-confer"> {
      try {
        parseWhoami(await run(["linkedin", "whoami"], { timeoutMs: WHOAMI_TIMEOUT_MS }));
        return cred;
      } catch (err) {
        if (err instanceof OpencliAuthError) return "re-confer";
        return cred;
      }
    },
  };
}

// ── conferral setup ───────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("setup cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build the LinkedIn conferral setup. A linear coroutine:
 *   1. `ctx.step("probe-session")` — an already-signed-in browser confers
 *      immediately with no guardian interaction,
 *   2. open the LinkedIn login page in the server browser (best-effort) and
 *      show the sign-in walkthrough,
 *   3. `ctx.step("await-login")` — poll `whoami` until the session reads
 *      authenticated (or time out after 10 minutes),
 *   4. return the terminal conferral: custody marker + whoami identity.
 * Nothing durable exists before the terminal return — cancelling writes
 * nothing, and the only state "accumulated" is LinkedIn's own browser cookie.
 */
export function makeLinkedInSetup(deps: {
  run: RunOpencli;
  openLoginTab: (url: string) => Promise<boolean>;
}): SetupFn {
  const probe = async (signal: AbortSignal): Promise<LinkedInWhoami | null> => {
    try {
      return parseWhoami(
        await deps.run(["linkedin", "whoami"], { timeoutMs: WHOAMI_TIMEOUT_MS, signal }),
      );
    } catch (err) {
      if (err instanceof OpencliAuthError) return null;
      throw err;
    }
  };

  return async (interact, ctx) => {
    let identity = await ctx.step("probe-session", async (signal) => {
      try {
        return await probe(signal);
      } catch {
        // A transient probe failure (Chrome still booting) is not a verdict;
        // fall through to the interactive sign-in path.
        return null;
      }
    });

    if (!identity) {
      await deps.openLoginTab(LINKEDIN_LOGIN_URL).catch(() => false);
      interact.show({
        title: "Sign in to LinkedIn in Rome's browser",
        body: [
          "Rome reads your LinkedIn inbox through its own browser, so the sign-in happens there — your password never passes through Rome.",
        ],
        links: [{ label: "Open Rome's browser", url: "/desktop" }],
        steps: [
          { text: "Open Rome's browser — a LinkedIn login tab is already waiting" },
          { text: "Sign in to LinkedIn as usual (approve any verification prompt)" },
          { text: "Leave the tab open; Rome detects the login automatically" },
        ],
        progress: true,
      });

      identity = await ctx.step("await-login", async (signal) => {
        const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
        for (;;) {
          if (signal.aborted) throw new Error("setup cancelled");
          let found: LinkedInWhoami | null = null;
          try {
            found = await probe(signal);
          } catch {
            // Transient: Chrome/CDP hiccups while the guardian is signing in.
          }
          if (found) return found;
          if (Date.now() >= deadline) {
            throw new Error(
              "Timed out waiting for the LinkedIn login. Open Rome's browser, finish signing in, then connect again.",
            );
          }
          await sleep(LOGIN_POLL_INTERVAL_MS, signal);
        }
      });
    }

    const profile = linkedinProfileFromIdentity(identity, new Date()) ?? undefined;
    return {
      credential: browserSessionCredential(),
      profile,
      ...(identity.publicId
        ? { guardianChannelUserId: `https://www.linkedin.com/in/${identity.publicId}/` }
        : {}),
      summary: {
        title: "LinkedIn connected",
        body: [
          `${identity.name ?? "Your LinkedIn account"} is signed in. Rome now mirrors your LinkedIn inbox periodically.`,
        ],
      },
    };
  };
}

// ── descriptor ────────────────────────────────────────────────────────────

/** Runtime deps threaded from index.ts, where the repos and config exist. */
export interface LinkedInDescriptorDeps {
  /** The inbox mirror (linkedin_threads/linkedin_messages). */
  syncSink: LinkedInSyncSink;
  /** Jitter bounds for the poll cadence (config `linkedinPoll*Minutes`). */
  minIntervalMs: number;
  maxIntervalMs: number;
  /** Injectable opencli runner (tests). */
  run?: RunOpencli;
  /** Injectable login-tab opener (tests). */
  openLoginTab?: (url: string) => Promise<boolean>;
}

interface LinkedInTalker extends Talker {
  getRuntimeDegradation(): CapabilityDegradation | null;
}

/**
 * The `channel_mappings.channel_user_id` a LinkedIn message resolves through.
 *
 * The bare member id is the address the mirror keys on — `linkedin_participants`
 * is primary-keyed by it and promotion writes it into the mapping — so a promoted
 * participant is recognised on their next message with nothing else wired up.
 *
 * The stored profile URL stays the fallback rather than being replaced by one:
 * a URL carrying no member id is a vanity handle (`/in/ada-lovelace`), which is
 * the form the guardian's own mapping is conferred in at connect time. Narrowing
 * to the member id alone would strand it.
 */
function linkedInChannelUserId(row: LinkedInHistoryMessage): string {
  return (
    linkedInMemberIdFromProfileUrl(row.senderProfileUrl) ??
    row.senderProfileUrl ??
    (row.senderIsSelf ? "linkedin:self" : "linkedin:unknown")
  );
}

function toHistoryNormalizedMessage(row: LinkedInHistoryMessage): NormalizedMessage {
  return {
    id: row.messageId,
    channel: "linkedin",
    channelUserId: linkedInChannelUserId(row),
    displayName: row.senderName ?? "",
    threadId: row.threadId,
    ...(row.threadName ? { threadName: row.threadName } : {}),
    threadType: "private",
    timestamp: row.sentAt,
    text: row.subject ? `${row.subject}\n${row.text ?? ""}`.trim() : (row.text ?? ""),
    attachments: [],
    rawEvent: row,
  };
}

export function createLinkedInDescriptor(deps: LinkedInDescriptorDeps): ConnectionDescriptor {
  const run = deps.run ?? runOpencli;
  const sessionScheme = linkedinSessionScheme(run);
  sessionScheme.setup = makeLinkedInSetup({
    run,
    openLoginTab: deps.openLoginTab ?? openLinkedInBrowserTab,
  });

  return {
    service: "linkedin",
    reviveProfile: (_grant, record) => reviveLinkedInProfile(record),
    auth: {
      session: sessionScheme,
    },
    capabilities: {
      talker: {
        needs: ["session"] as const,
        build(): Talker {
          const poller = new LinkedInInboxPoller({
            sink: deps.syncSink,
            run,
            minIntervalMs: deps.minIntervalMs,
            maxIntervalMs: deps.maxIntervalMs,
          });

          const talker: LinkedInTalker = {
            // v1 is a mirror: nothing is delivered into the agent pipeline, so
            // `deliver` stays unused until LinkedIn messages join the routed
            // inbound path.
            start(_deliver, fault): void {
              poller.start({
                onAuthRejected: (cause) =>
                  fault(new CredentialRejected({ grant: "session", cause })),
              });
            },
            stop(): void {
              poller.stop();
            },
            async send(conversationId: ConversationId, msg) {
              if (
                !msg.text?.trim() ||
                msg.attachments?.length ||
                msg.replyToMessageId ||
                msg.kind === "email" ||
                msg.parts?.length
              ) {
                throw new Error("LinkedIn replies support plain text only");
              }
              const target = await deps.syncSink.findReplyTarget?.({ threadId: conversationId });
              if (!target)
                throw new Error("No verified LinkedIn direct conversation for this reply");
              if (
                target.threadId !== conversationId ||
                target.threadUrl !== `https://www.linkedin.com/messaging/thread/${conversationId}/`
              ) {
                throw new Error("LinkedIn reply target does not match the selected conversation");
              }
              let message;
              try {
                message = parseLinkedInReply(
                  await run(
                    [
                      "linkedin",
                      "reply",
                      "--thread-url",
                      target.threadUrl,
                      "--expected-recipient",
                      target.participantId,
                      "--expected-self",
                      target.selfParticipantId,
                      "--message",
                      msg.text,
                      "--send",
                    ],
                    { timeoutMs: 180_000 },
                  ),
                  conversationId,
                );
              } catch (error) {
                if (error instanceof OpencliAuthError) {
                  throw new CredentialRejected({ grant: "session", cause: error });
                }
                throw error;
              }
              try {
                await deps.syncSink.upsertMessages([message]);
              } catch (error) {
                // Provider acceptance survives a local mirror failure. The next poll repairs it.
                log.warn("LinkedIn reply accepted but mirror write failed", {
                  threadId: conversationId,
                  messageId: message.messageId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              return { conversationId, messageId: message.messageId };
            },
            feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
              const sink = deps.syncSink;
              const features: Partial<TalkFeatureMap> = {};
              if (sink.findReplyTarget) {
                features.directMessaging = {
                  async conversationFor(address: string) {
                    const participantId = linkedInMemberIdFromProfileUrl(address) ?? address.trim();
                    const target = await sink.findReplyTarget?.({ participantId });
                    return target ? (target.threadId as ConversationId) : null;
                  },
                };
              }
              if (sink.fetchHistory) {
                features.history = historyFeature({
                  fetchHistory: async (conversationId, windowHours) => {
                    const since = new Date(Date.now() - windowHours * 3_600_000);
                    const rows = await sink.fetchHistory?.(conversationId, since);
                    return (rows ?? []).map(toHistoryNormalizedMessage);
                  },
                });
              }
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
            getRuntimeDegradation(): CapabilityDegradation | null {
              return poller.getRuntimeDegradation();
            },
          };
          return talker;
        },
        degradation(instance: Talker): CapabilityDegradation | null {
          return (instance as LinkedInTalker).getRuntimeDegradation();
        },
      },
    },
  };
}
