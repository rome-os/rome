// Telegram user-account connection integration. Channel contract: docs/architecture/channels.md.
//
// Unlike the bot channel (integrations/telegram.ts), this is a *user* session:
// a single `session` grant holding a GramJS StringSession plus the account
// identity fields (apiId/apiHash/phoneNumber/userId/…). There is no interactive
// confer() — conferral runs the setup coroutine (`makeTelegramUserSetup`
// below): API credentials + phone number → phone code → optional 2FA password,
// whose terminal return is the single ledger write of credential material +
// identity profile. The transport core — connect, NewMessage streaming,
// normalization, media download, send, history — is the existing
// `TelegramUserAdapter`
// (packages/core/src/channels/telegram-user.ts), wrapped here so the runtime's
// grant-epoch lifecycle and fault→grant-state mapping drive it.
//
// GramJS owns transient reconnection (connectionRetries); only TERMINAL failures
// reach `fault`:
//   - a 401 / AUTH_KEY_UNREGISTERED / SESSION_REVOKED (at start, or observed by
//     the in-epoch session probe) → CredentialRejected{ grant: "session" } →
//     runtime renews once ("re-confer"), then degrades.
//   - any other terminal transport failure → Disconnected → runtime backs off
//     and rebuilds.
//
// The session probe: GramJS user sessions die silently — the
// account can revoke the session while the socket stays open and no NewMessage
// ever arrives — so the Talk epoch polls `checkAuthorization` on its OWN live
// client on a fixed interval. An auth failure is reported through the same
// `fault` callback every Talker receives (→ CredentialRejected → the grant
// degrades with reason + timestamp). A network failure is NOT a fault: the live
// NewMessage stream + GramJS reconnection own transport health, so a probe blip
// stays silent. The probe is a private idiom of this one integration (the only
// channel with silent-death sessions), NOT a health-check surface on the
// descriptor contract. No concurrent-relogin version guard is needed: the
// registry already drops faults from superseded epochs (a re-login rebuilds the
// epoch and the old epoch's in-flight probe fault is discarded).

import { z } from "zod";
import type { TalkDirectory, TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import {
  isTelegramUserSessionRejected,
  openTelegramUserLogin,
  TelegramUserAdapter,
  type TelegramUserLoginHandle,
  type TelegramUserSettings,
} from "../../channels/telegram-user.js";
import { CredentialRejected, Disconnected } from "../errors.js";
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
import {
  directoryCursorOffset,
  directoryPage,
  historyFeature,
  inboundMediaFeature,
  toInboundMessage,
  toMessageReceipt,
} from "./talk-features.js";

// The `session` grant's profile — the non-secret half of the user-account login
// (who the account is, its phone, when it connected). Declared next to the
// material serializer; parse-then-store, same schema re-runs on revive
// (fail-closed). The session string / apiHash are credential material, never
// profile. `displayName`/`username` are the display fields; `userId`/
// `phoneNumber`/`connectedAt` stay owner-side. All optional so a bridge-era grant
// stays sparse-but-valid.
export const telegramUserGrantProfileSchema = z
  .object({
    /** Telegram numeric user id (owner-side identity). */
    userId: z.string().min(1).optional(),
    /** `@handle`, when the account set one. */
    username: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    phoneNumber: z.string().min(1).optional(),
    /** ISO timestamp the login completed (owner-side). */
    connectedAt: z.string().min(1).optional(),
  })
  .strict();
export type TelegramUserGrantProfile = z.infer<typeof telegramUserGrantProfileSchema>;

/** Pure display projection: the account name is the display name, the @handle the
 *  handle. `userId`/`phoneNumber`/`connectedAt` are owner-side and never widen the
 *  display surface. */
export function toTelegramUserDisplay(profile: TelegramUserGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    handle: profile.username,
    email: undefined,
    avatarUrl: undefined,
  });
}

/** Revive a stored telegram-user profile: re-parse with the schema, then map
 *  through the pure display function (fail-closed on a record that no longer
 *  matches). */
export function reviveTelegramUserProfile(record: ProfileRecord): ProfileDisplay {
  return toTelegramUserDisplay(telegramUserGrantProfileSchema.parse(record));
}

/** The identity fields the telegram-user settings row carries (login output). */
export interface TelegramUserProfileSource {
  userId?: string;
  username?: string | null;
  displayName?: string;
  phoneNumber?: string;
  connectedAt?: string;
}

/** Build the parsed grant profile from the settings row, or null when the row
 *  carries no identity to record. */
export function telegramUserProfileFromSettings(
  settings: TelegramUserProfileSource,
): TelegramUserGrantProfile | null {
  const raw: Record<string, unknown> = {};
  const fields = {
    userId: settings.userId,
    username: settings.username,
    displayName: settings.displayName,
    phoneNumber: settings.phoneNumber,
    connectedAt: settings.connectedAt,
  };
  for (const [key, value] of Object.entries(fields)) {
    // null / undefined / "" are absent; every other present value flows through
    // untouched so the strict parse — not this picker — decides validity.
    if (value != null && value !== "") raw[key] = value;
  }
  if (Object.keys(raw).length === 0) return null;
  return telegramUserGrantProfileSchema.parse(raw);
}

/**
 * A setup-driven session scheme: there is no headless `confer()` — conferral runs
 * the interactive phone-code + optional 2FA login coroutine attached in
 * `makeTelegramUserDescriptor`, whose terminal return is the single
 * ledger write. `renew()` cannot refresh a user session without the guardian, so
 * it answers "re-confer", driving the runtime's renew-once → degrade path.
 */
function telegramUserSession(): AuthScheme {
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
 * Serialize a `TelegramUserSettings` row into the flat `SecretRecord` the grant
 * ledger stores. Every field is a string (SecretRecord = Record<string,string>);
 * `apiId` is stringified and `username` (nullable) becomes `""` when absent so
 * the round-trip is lossless. Exported so the settings-import row (wire stage)
 * and the connect route build material the same way.
 */
export function telegramUserMaterialFromSettings(settings: TelegramUserSettings): SecretRecord {
  return {
    apiId: String(settings.apiId),
    apiHash: settings.apiHash,
    sessionString: settings.sessionString,
    phoneNumber: settings.phoneNumber,
    userId: settings.userId,
    username: settings.username ?? "",
    displayName: settings.displayName,
    connectedAt: settings.connectedAt,
  };
}

/** Reconstruct a `TelegramUserSettings` from grant material. Inverse of
 *  {@link telegramUserMaterialFromSettings}; `""`/absent username → null. */
export function telegramUserSettingsFromMaterial(material: SecretRecord): TelegramUserSettings {
  return {
    apiId: Number(material.apiId),
    apiHash: material.apiHash,
    sessionString: material.sessionString,
    phoneNumber: material.phoneNumber,
    userId: material.userId,
    username: material.username ? material.username : null,
    displayName: material.displayName,
    connectedAt: material.connectedAt,
  };
}

// ── conferral setup ───────────────────────────────────────────────

/** Validate + normalize the API credentials and phone number the guardian
 *  enters. Returns the parsed values, or a re-prompt error message. */
function parseTelegramUserCredentials(
  answers: Record<string, string>,
):
  | { ok: true; apiId: number; apiHash: string; phoneNumber: string }
  | { ok: false; error: string } {
  const apiIdRaw = (answers.apiId ?? "").trim();
  const apiId = /^\d+$/.test(apiIdRaw) ? Number.parseInt(apiIdRaw, 10) : Number.NaN;
  if (!Number.isInteger(apiId) || apiId <= 0) {
    return { ok: false, error: "API ID must be a positive integer." };
  }
  const apiHash = (answers.apiHash ?? "").trim();
  if (!apiHash) return { ok: false, error: "API hash is required." };
  const digits = (answers.phoneNumber ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: "Invalid phone number. Use country code + digits only." };
  }
  return { ok: true, apiId, apiHash, phoneNumber: `+${digits}` };
}

/**
 * Build the Telegram user-account conferral setup. A linear coroutine:
 *   1. prompt the API ID / API hash / phone number (re-prompt on invalid input),
 *   2. `ctx.step("send-code")` — connect a throwaway client and request the code,
 *   3. prompt the phone code and sign in (re-prompt on an invalid/expired code),
 *   4. when Telegram asks for 2FA, prompt the cloud password with the wrong-
 *      password re-prompt loop (`prompt(form, { error })`),
 *   5. stop the login client, then return the terminal conferral: the serialized
 *      session material + identity profile.
 * The runtime performs the single durable write from the returned conferral;
 * cancel/abandon stops the login client and writes nothing. Unlike the bot
 * channels there is no guardian-link step — a user session IS the guardian's own
 * account, so no `guardianChannelUserId` is mapped.
 */
export function makeTelegramUserSetup(deps: {
  openLogin: (apiId: number, apiHash: string) => TelegramUserLoginHandle;
}): SetupFn {
  return async (interact, ctx) => {
    // 1. Collect + validate the API credentials and phone number.
    let creds: { apiId: number; apiHash: string; phoneNumber: string };
    let credError: string | undefined;
    for (;;) {
      const answers = await interact.prompt({
        instructions:
          "Create an app at my.telegram.org/apps to get your API ID and API hash, then enter the phone number of the Telegram account to connect (country code first).",
        fields: [
          { name: "apiId", label: "API ID", secret: false },
          { name: "apiHash", label: "API hash", secret: true },
          { name: "phoneNumber", label: "Phone number", secret: false },
        ],
        ...(credError ? { error: credError } : {}),
      });
      const parsed = parseTelegramUserCredentials(answers);
      if (parsed.ok) {
        creds = { apiId: parsed.apiId, apiHash: parsed.apiHash, phoneNumber: parsed.phoneNumber };
        break;
      }
      credError = parsed.error;
    }

    const login = deps.openLogin(creds.apiId, creds.apiHash);
    let conferred = false;
    try {
      // 2. Send the phone code (external event → ctx.step).
      const { isCodeViaApp } = await ctx.step("send-code", () => login.sendCode(creds.phoneNumber));

      // 3. Collect the phone code and sign in (re-prompt on an invalid code). A
      //    SESSION_PASSWORD_NEEDED result routes to the 2FA prompt below.
      let account: TelegramUserSettings | null = null;
      let passwordHint: string | null = null;
      let codeError: string | undefined;
      for (;;) {
        const answers = await interact.prompt({
          instructions: isCodeViaApp
            ? "Telegram sent a login code to your Telegram app. Enter it below."
            : "Telegram sent a login code by SMS. Enter it below.",
          fields: [{ name: "code", label: "Login code", secret: false }],
          ...(codeError ? { error: codeError } : {}),
        });
        try {
          const outcome = await ctx.step("submit-code", () =>
            login.submitCode((answers.code ?? "").trim()),
          );
          if (outcome.status === "connected") {
            account = outcome.account;
          } else {
            passwordHint = outcome.passwordHint;
          }
          break;
        } catch (err) {
          // A cancel that aborted the sign-in unwinds the setup, not re-prompts.
          if (ctx.signal.aborted) throw err;
          codeError = err instanceof Error ? err.message : "Invalid code. Try again.";
        }
      }

      // 4. Two-step verification: prompt the cloud password, re-prompting on a
      //    wrong one until it is accepted (or the guardian cancels).
      if (!account) {
        let passwordError: string | undefined;
        for (;;) {
          const answers = await interact.prompt({
            instructions: passwordHint
              ? `Enter your Telegram two-step verification password (hint: ${passwordHint}).`
              : "Enter your Telegram two-step verification password.",
            fields: [{ name: "password", label: "Password", secret: true }],
            ...(passwordError ? { error: passwordError } : {}),
          });
          try {
            account = await ctx.step("submit-password", () =>
              login.submitPassword(answers.password ?? ""),
            );
            break;
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            passwordError = err instanceof Error ? err.message : "Incorrect password. Try again.";
          }
        }
      }

      // 5. Stop the login client BEFORE the terminal write: the registry builds
      //    the real Talk from the ledger the moment the credential lands, and a
      //    second live GramJS client on the same session risks AUTH_KEY_DUPLICATED.
      await login.stop();
      conferred = true;

      const material = telegramUserMaterialFromSettings(account);
      const profile = telegramUserProfileFromSettings(account) ?? undefined;
      return {
        credential: { material, expiresAt: "never" },
        profile,
        summary: {
          title: "Telegram account connected",
          body: [
            `${account.displayName || account.username || account.phoneNumber} is connected and can send and read messages as you.`,
          ],
        },
      };
    } finally {
      // Cancel, fault, or any throw above: disconnect the pending client. Nothing
      // durable exists — the session lived in the login client's memory only.
      if (!conferred) await login.stop().catch(() => {});
    }
  };
}

/** How often the Talk epoch probes its live session's authorization. User
 *  sessions rarely die, and each probe is a round-trip, so the cadence is slow. */
export const TELEGRAM_USER_SESSION_PROBE_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Runtime deps for the descriptor. `probeIntervalMs` overrides the session-probe
 * cadence — a test seam only (real callers take the 4-hour default); no other
 * runtime dep is threaded from index.ts.
 */
export interface TelegramUserDeps {
  probeIntervalMs?: number;
  /** Injectable interactive-login factory for the setup (tests). Defaults
   *  to a real throwaway GramJS client + empty session. */
  openLogin?: (apiId: number, apiHash: string) => TelegramUserLoginHandle;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

/** Build the Telegram-user descriptor. */
export function makeTelegramUserDescriptor(deps: TelegramUserDeps = {}): ConnectionDescriptor {
  const probeIntervalMs = deps.probeIntervalMs ?? TELEGRAM_USER_SESSION_PROBE_INTERVAL_MS;
  const session = telegramUserSession();
  // The phone-code + optional 2FA login coroutine. Its terminal return
  // is the single ledger write (credential material + identity profile).
  session.setup = makeTelegramUserSetup({ openLogin: deps.openLogin ?? openTelegramUserLogin });
  return {
    service: "telegram_user",
    reviveProfile: (_grant, record) => reviveTelegramUserProfile(record),
    auth: {
      session,
    },
    capabilities: {
      talker: {
        needs: ["session"] as const,
        history: true,
        build(creds, kit): Talker {
          const settings = telegramUserSettingsFromMaterial(creds.session.material as SecretRecord);
          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          let probeTimer: ReturnType<typeof setInterval> | null = null;
          let probeInFlight = false;

          const routeFault = (err: unknown): void => {
            faultSink?.(
              isTelegramUserSessionRejected(err)
                ? new CredentialRejected({ grant: "session", cause: err })
                : new Disconnected(err),
            );
          };

          const adapter = new TelegramUserAdapter(settings);

          // One session-probe tick: an auth failure is a refused credential
          // (→ CredentialRejected → degrade); a network failure is transport, not
          // a fault, so it is swallowed — the live stream + GramJS reconnection
          // own transport health. Reports through the SAME `faultSink` the epoch
          // already holds, so a superseded epoch's late tick is dropped by the
          // registry (its fault callback checks the epoch is still current).
          // Single-flight: a probe against a stalled client can outlive the
          // interval, and stacking checkAuthorization calls on a wedged socket
          // only deepens the wedge — a tick that finds one in flight is skipped.
          const probeOnce = async (): Promise<void> => {
            if (probeInFlight) return;
            probeInFlight = true;
            try {
              await adapter.probe();
            } catch (err) {
              if (isTelegramUserSessionRejected(err)) {
                faultSink?.(new CredentialRejected({ grant: "session", cause: err }));
              }
            } finally {
              probeInFlight = false;
            }
          };

          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onMessage(async (msg) => deliver(toInboundMessage(msg)));
              // adapter.start() connects then checks authorization, throwing a
              // TelegramUserSessionNotAuthorizedError (→ CredentialRejected) on a
              // revoked session; other terminal transport errors → Disconnected.
              adapter.start().catch(routeFault);
              // Poll the live session's authorization for the epoch's lifetime;
              // the timer is cleared on stop() so it dies with the epoch.
              probeTimer = setInterval(() => void probeOnce(), probeIntervalMs);
              unrefTimer(probeTimer);
            },
            stop(): Promise<void> {
              if (probeTimer) {
                clearInterval(probeTimer);
                probeTimer = null;
              }
              return adapter.stop();
            },
            async send(conversationId, msg) {
              try {
                return toMessageReceipt(
                  conversationId,
                  await adapter.sendMessage(conversationId, conversationId, msg),
                );
              } catch (err) {
                // A 401 / session-revoked from send() is a refused credential.
                if (isTelegramUserSessionRejected(err)) {
                  throw new CredentialRejected({ grant: "session", cause: err });
                }
                throw err;
              }
            },
            feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
              const directory: TalkDirectory = {
                async listConversations(input) {
                  const dialogs = await adapter.listDialogs(
                    directoryCursorOffset(input.cursor) + input.limit,
                  );
                  const query = input.query?.toLocaleLowerCase();
                  const page = directoryPage(
                    dialogs
                      .filter(
                        (dialog) => !query || dialog.title.toLocaleLowerCase().includes(query),
                      )
                      .sort((left, right) =>
                        `${left.title}\0${left.id}`.localeCompare(`${right.title}\0${right.id}`),
                      ),
                    input,
                  );
                  return {
                    conversations: page.items.map((dialog) => ({
                      ref: {
                        connectionId: kit.connectionId,
                        conversationId: dialog.id as import("@rome-os/app-runtime").ConversationId,
                      },
                      service: "telegram_user",
                      kind:
                        dialog.type === "private"
                          ? ("dm" as const)
                          : dialog.type === "group"
                            ? ("group" as const)
                            : ("channel" as const),
                      displayName: dialog.title,
                    })),
                    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                  };
                },
              };
              const features: Partial<TalkFeatureMap> = {
                inboundMedia: inboundMediaFeature(adapter),
                history: historyFeature(adapter, {
                  channel: "telegram_user",
                  // The account's own lines, the way the adapter tells them apart.
                  isOwn: (message) => (message.rawEvent as { out?: unknown } | null)?.out === true,
                }),
                directory,
              };
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
          };
        },
      },
    },
  };
}
