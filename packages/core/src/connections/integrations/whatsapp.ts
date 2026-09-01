// WhatsApp connection integration. Channel contract: docs/architecture/channels.md.
//
// WhatsApp is a Talker with a single `session` grant: a linked-device session
// (Baileys auth state) that comes from entering a pairing code on the phone. The
// transport core — normalization, address-book sync, media download, the
// generation-gated reconnect loop — is the existing `WhatsAppAdapter`
// (packages/core/src/channels/whatsapp.ts), wrapped here.
//
// Two things make WhatsApp the hard channel:
//   1. Custody. Baileys rotates signal keys constantly and must persist them or
//      the session dies on restart. The old adapter owned a directory
//      (`useMultiFileAuthState`); here the session lives in the grant material
//      and every mutation write-throughs via `kit.persist("session", …)` — see
//      createWhatsAppAuthState. On stop() we `flush()` the debounce so the final
//      rotation is never lost.
//   2. Conferral is a pairing handshake. The setup coroutine below
//      drives it over a TRANSIENT socket whose mutating auth state lives in
//      setup memory only; the coroutine's return is the one durable write, so
//      an abandoned or cancelled pairing leaves zero durable state. renew() is
//      "re-confer": a dead session can only be re-linked.
//
// Fault mapping: the adapter owns transient reconnection; only
// terminal outcomes reach `fault`. DisconnectReason.loggedOut (device unlinked)
// → CredentialRejected{ grant: "session" }; any other terminal → Disconnected.

import { z } from "zod";
import type { TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import { WhatsAppAdapter, type WhatsAppAuthProvider } from "../../channels/whatsapp.js";
import type { WhatsAppSyncSink } from "../../channels/whatsapp-sync.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import type { SetupFn } from "../setup/types.js";
import type {
  AuthScheme,
  Connection,
  ConnectionDescriptor,
  Credential,
  GuardianInteraction,
  ProfileDisplay,
  ProfileRecord,
  RuntimeKit,
  SecretRecord,
  Talker,
} from "../types.js";
import {
  createWhatsAppAuthState,
  readWhatsAppAuthStateFromDirectory,
  type WhatsAppAuthMaterial,
} from "./whatsapp-auth-state.js";
import {
  historyFeature,
  inboundMediaFeature,
  toInboundMessage,
  toMessageReceipt,
} from "./talk-features.js";

/** Runtime deps the WhatsApp adapter needs that `kit` cannot supply: the
 *  address-book store mirror and the guardian auto-map callback. Threaded in at
 *  registration time from index.ts, where the repos exist — the descriptor is
 *  otherwise pure. */
export interface WhatsAppDescriptorDeps {
  /** The address-book store mirror (waContacts/waChats/history), fed every
   *  Baileys sync event. `WhatsAppStoreRepository` is the production sink. */
  syncSink: WhatsAppSyncSink;
  /** Auto-map the guardian onto their own WhatsApp identity on connect. Called
   *  with the canonical self JID the adapter derives on `connection: "open"`. */
  onGuardianConnected: (selfJid: string) => void;
  /** Injectable socket factory (tests). Defaults to the real WhatsAppAdapter. */
  createAdapter?: (authProvider: WhatsAppAuthProvider) => WhatsAppAdapter;
  /** Injectable transient pairing-socket factory for the setup (tests).
   *  Defaults to a real adapter over an in-memory (setup-only) auth state. */
  openPairing?: () => WhatsAppPairingHandle;
}

/** The `session` material shape (two BufferJSON strings). */
export type WhatsAppSessionMaterial = WhatsAppAuthMaterial;

/**
 * The `session` auth scheme: conferral is driven by the setup attached
 * in `createWhatsAppDescriptor`, so confer() must never run headlessly. A
 * linked session cannot renew without re-pairing, so renew() is "re-confer".
 */
export function whatsappSessionScheme(): AuthScheme {
  return {
    async confer(_interact: GuardianInteraction): Promise<Credential> {
      throw new Error("conferral driven by the connection setup");
    },
    async renew(): Promise<Credential | "re-confer"> {
      return "re-confer";
    },
  };
}

// ── Grant profile ─────────────────────────────────────────────────────────
// The non-secret conferral outcome recorded beside the session credential: the
// linked account's phone number + canonical self JID.

const whatsappGrantProfileSchema = z
  .object({
    phoneNumber: z.string().min(1),
    jid: z.string().min(1),
  })
  .strict();

export type WhatsAppGrantProfile = z.infer<typeof whatsappGrantProfileSchema>;

/** Build the grant profile from the canonical self JID
 *  (`<pn>@s.whatsapp.net`), or null when the JID carries no phone number. */
export function whatsappProfileFromJid(selfJid: string): WhatsAppGrantProfile | null {
  const phoneNumber = selfJid.split("@")[0]?.split(":")[0] ?? "";
  if (!/^\d+$/.test(phoneNumber)) return null;
  return { phoneNumber, jid: selfJid };
}

function toWhatsAppDisplay(profile: WhatsAppGrantProfile): ProfileDisplay {
  return {
    displayName: undefined,
    handle: `+${profile.phoneNumber}`,
    email: undefined,
    avatarUrl: undefined,
  };
}

export function reviveWhatsAppProfile(record: ProfileRecord): ProfileDisplay {
  return toWhatsAppDisplay(whatsappGrantProfileSchema.parse(record));
}

// ── conferral setup ───────────────────────────────────────────────

/**
 * One transient pairing attempt: a throwaway socket over an IN-MEMORY auth
 * state (no disk, no ledger — abandoning the setup writes nothing). The setup
 * coroutine drives it; `serialize()` yields the accumulated session material
 * for the terminal conferral.
 */
export interface WhatsAppPairingHandle {
  /** Start the transient socket. */
  start(): Promise<void>;
  /** Request a pairing code for the (digits-only) phone number. */
  requestPairingCode(phoneNumber: string): Promise<string>;
  /** Resolves with the canonical self JID once the device links; rejects on a
   *  terminal pairing fault. */
  waitForPaired(): Promise<string>;
  /** The session material accumulated in memory so far. */
  serialize(): WhatsAppAuthMaterial;
  /** Stop the transient socket (idempotent). */
  stop(): Promise<void>;
}

/** The production pairing handle: a real adapter over an in-memory auth state
 *  whose persist hook is a no-op — during setup the mutating session state
 *  lives in setup memory only. The sync sink still mirrors contacts/history so
 *  the address book populates during pairing (parity with the pre-cutover
 *  transient socket); the real Talker re-attaches the same sink post-confer. */
function openWhatsAppPairingSocket(
  createAdapter: (authProvider: WhatsAppAuthProvider) => WhatsAppAdapter,
  syncSink: WhatsAppSyncSink,
): WhatsAppPairingHandle {
  const auth = createWhatsAppAuthState(null, async () => {});
  const adapter = createAdapter(async () => ({ state: auth.state, saveCreds: auth.saveCreds }));
  adapter.onSync(syncSink);
  const paired = new Promise<string>((resolve, reject) => {
    adapter.onConnected(resolve);
    // The adapter owns transient reconnection; only terminal outcomes land here.
    adapter.onFault((fault) => {
      reject(
        fault.kind === "loggedOut"
          ? new Error("WhatsApp rejected the pairing. Start over and try again.")
          : new Error("WhatsApp connection failed during pairing."),
      );
    });
  });
  // A cancelled setup abandons the wait; don't surface an unhandled rejection.
  paired.catch(() => {});
  return {
    start: () => adapter.start(),
    requestPairingCode: (phoneNumber) => adapter.requestPairingCode(phoneNumber),
    waitForPaired: () => paired,
    serialize: () => auth.serialize(),
    stop: () => adapter.stop(),
  };
}

/** Group an 8-char pairing code as XXXX-XXXX for reading off the screen. */
function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Build the WhatsApp conferral setup. A linear coroutine:
 *   1. prompt the phone number (re-prompt on an invalid one, carrying the error),
 *   2. spin up the transient pairing socket and request a pairing code,
 *   3. show the code + the on-phone steps,
 *   4. `ctx.step("paired")` — wait for the Baileys handshake to reach `open`,
 *   5. stop the transient socket, then return the terminal conferral: the
 *      in-memory session material + whatsapp profile + guardian mapping.
 * The runtime performs the single durable write from the returned conferral;
 * cancel/abandon tears the socket down and writes nothing.
 */
export function makeWhatsAppSetup(deps: { openPairing: () => WhatsAppPairingHandle }): SetupFn {
  return async (interact, ctx) => {
    let error: string | undefined;
    let phoneNumber: string;
    for (;;) {
      const answers = await interact.prompt({
        instructions:
          "Enter the phone number of the WhatsApp account to link — country code first, digits only (e.g. 14155551234).",
        fields: [{ name: "phoneNumber", label: "Phone number", secret: false }],
        ...(error ? { error } : {}),
      });
      const digits = (answers.phoneNumber ?? "").replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) {
        phoneNumber = digits;
        break;
      }
      error = "Invalid phone number. Use country code + digits only.";
    }

    const pairing = deps.openPairing();
    let conferred = false;
    try {
      const code = await ctx.step("pairing-code", async () => {
        await pairing.start();
        return pairing.requestPairingCode(phoneNumber);
      });

      interact.show({
        title: "Enter this code on your phone",
        body: [formatPairingCode(code)],
        steps: [
          { text: "Open WhatsApp on your phone" },
          { text: "Go to Settings → Linked Devices → Link a Device" },
          { text: "Tap “Link with phone number instead” and enter the code" },
        ],
        progress: true,
      });

      const selfJid = await ctx.step("paired", () => pairing.waitForPaired());

      // Stop the transient socket BEFORE the conferral commit — WhatsApp rejects
      // a second concurrent socket on the same session, and the registry builds
      // the real Talker from the ledger the moment the credential lands.
      await pairing.stop();
      const material = pairing.serialize();
      conferred = true;
      const profile = whatsappProfileFromJid(selfJid) ?? undefined;
      return {
        credential: { material, expiresAt: "never" },
        profile,
        guardianChannelUserId: selfJid,
        summary: {
          title: "WhatsApp connected",
          body: [
            `${profile ? `+${profile.phoneNumber}` : "Your WhatsApp"} is linked and your account is mapped as guardian.`,
          ],
        },
      };
    } finally {
      // Cancel, fault, or any throw above: tear the transient socket down.
      // Nothing durable exists — the auth state lived in setup memory only.
      if (!conferred) await pairing.stop().catch(() => {});
    }
  };
}

/**
 * Coerce grant material into the serialized WhatsApp session shape, or null when
 * it carries no creds yet (a transient/placeholder session) — createWhatsAppAuthState
 * then starts from a fresh `initAuthCreds()`.
 */
function asSessionMaterial(material: SecretRecord): WhatsAppAuthMaterial | null {
  if (!material.creds) return null;
  return { creds: material.creds, keys: material.keys ?? "{}" };
}

/**
 * Build the WhatsApp descriptor. `deps` carries the store sink + guardian-map
 * callback (kit has no store access), threaded from index.ts at registration.
 */
export function createWhatsAppDescriptor(deps: WhatsAppDescriptorDeps): ConnectionDescriptor {
  const createAdapter =
    deps.createAdapter ?? ((authProvider) => new WhatsAppAdapter({ authProvider }));
  const openPairing =
    deps.openPairing ?? (() => openWhatsAppPairingSocket(createAdapter, deps.syncSink));

  const sessionScheme = whatsappSessionScheme();
  // The WhatsApp conferral setup: prompt the phone number, drive the
  // Baileys pairing handshake over a transient in-memory socket, then land the
  // session material + profile + guardian mapping in one terminal write.
  sessionScheme.setup = makeWhatsAppSetup({ openPairing });

  return {
    service: "whatsapp",
    reviveProfile: (_grant, record) => reviveWhatsAppProfile(record),
    auth: {
      session: sessionScheme,
    },
    capabilities: {
      talker: {
        needs: ["session"] as const,
        build(creds, kit: RuntimeKit): Talker {
          const material = asSessionMaterial(creds.session.material as SecretRecord);
          // One auth state for the whole Talker lifetime: every socket
          // generation (initial + each reconnect) reads the SAME live record,
          // and every mutation write-throughs via kit.persist("session", …).
          const auth = createWhatsAppAuthState(material, (next) => kit.persist("session", next));

          const adapter = createAdapter(async () => ({
            state: auth.state,
            saveCreds: auth.saveCreds,
          }));
          adapter.onSync(deps.syncSink);
          adapter.onConnected(deps.onGuardianConnected);

          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          adapter.onFault((fault) => {
            faultSink?.(
              fault.kind === "loggedOut"
                ? new CredentialRejected({ grant: "session", cause: fault.cause })
                : new Disconnected(fault.cause),
            );
          });

          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onMessage(async (msg) => deliver(toInboundMessage(msg)));
              // start() awaits the socket build; a fatal build error surfaces as
              // Disconnected (transient reconnect owns recoverable failures).
              adapter.start().catch((err) => fault(new Disconnected(err)));
            },
            async stop(): Promise<void> {
              await adapter.stop();
              // Persist the final rotation before the process exits — the debounce
              // must not swallow the last creds/keys mutation on shutdown.
              await auth.flush();
            },
            async send(conversationId, msg) {
              return toMessageReceipt(
                conversationId,
                await adapter.sendMessage(conversationId, conversationId, msg),
              );
            },
            feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
              const features: Partial<TalkFeatureMap> = {
                inboundMedia: inboundMediaFeature(adapter),
                history: historyFeature(adapter),
              };
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
          };
        },
      },
    },
  };
}

/**
 * One-time settings→ledger migration for WhatsApp. If the ledger
 * has no `session` credential yet but the legacy settings row points at a
 * `useMultiFileAuthState` directory with a `creds.json`, read the directory ONCE
 * into serialized material and importCredential. The directory is NOT deleted
 * (rollback safety). If the ledger already holds an authorized or degraded
 * session, it wins — this is a no-op. The wire stage calls this from the
 * settings-import table row.
 */
export async function importWhatsAppSessionFromDirectory(opts: {
  connection: Connection;
  authStatePath: string;
  importCredential: (grant: "session", cred: Credential) => Promise<void>;
}): Promise<void> {
  // Ledger wins after the first import. In particular, degraded retains the
  // last credential as inert material; re-reading the preserved legacy
  // directory would otherwise resurrect a rejected session on every reboot.
  if (opts.connection.auth.grants().session !== "unauthorized") return;
  const material = await readWhatsAppAuthStateFromDirectory(opts.authStatePath);
  if (!material) return;
  await opts.importCredential("session", { material, expiresAt: "never" });
}
