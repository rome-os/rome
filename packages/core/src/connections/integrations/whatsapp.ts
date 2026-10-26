// WhatsApp connection integration. Channel contract: docs/architecture/channels.md.
//
// WhatsApp is a Talker with a single `session` grant: a linked-device session
// (Baileys auth state) that comes from scanning a linking QR on the phone. The
// transport core — the inbound `ChannelMessage`, address-book sync, media
// download, the generation-gated reconnect loop — is `WhatsAppAdapter`
// (packages/core/src/channels/whatsapp.ts), wrapped here. The transport already
// speaks the channel's record, so inbound and send pass through without a
// projection.
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
import type { TalkFeatures } from "../types.js";
import { WhatsAppAdapter, type WhatsAppAuthProvider } from "../../channels/whatsapp.js";
import type { WhatsAppSyncSink } from "../../channels/whatsapp-sync.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import type { SetupFn, SetupView } from "../setup/types.js";
import type {
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  GuardianInteraction,
  ProfileDisplay,
  ProfileRecord,
  RuntimeKit,
  SecretRecord,
  Talker,
} from "../types.js";
import { createWhatsAppAuthState, type WhatsAppAuthMaterial } from "./whatsapp-auth-state.js";
import { addressIsConversationFeature } from "./talk-features.js";

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
  /** Injectable QR renderer (content → `data:` image URL); production uses the
   *  `qrcode` package. */
  makeQrDataUrl?: (content: string) => Promise<string>;
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
  /** Register the sink for each linking QR (raw content) WhatsApp issues. */
  onQr(callback: (qr: string) => void): void;
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
    onQr: (callback) => adapter.onQr(callback),
    waitForPaired: () => paired,
    serialize: () => auth.serialize(),
    stop: () => adapter.stop(),
  };
}

const LINK_STEPS = [
  { text: "Open WhatsApp on your phone" },
  { text: "Go to Settings → Linked Devices → Link a Device" },
  { text: "Point your phone at this QR code" },
];

/** The working view shown until WhatsApp issues the first QR. */
function whatsappPreparingView(): SetupView {
  return {
    title: "Link WhatsApp",
    body: ["Preparing the QR code…"],
    steps: LINK_STEPS,
    progress: true,
  };
}

/** The scan view. WhatsApp rotates the QR every ~20 s; each one repaints this
 *  view. The raw QR content is not a URL, so there is no link fallback. */
function whatsappQrView(qr: string): SetupView {
  return {
    title: "Scan with WhatsApp",
    body: ["Scan this QR code with WhatsApp on your phone. It refreshes automatically."],
    qr,
    steps: LINK_STEPS,
    progress: true,
  };
}

async function defaultQrDataUrl(content: string): Promise<string> {
  const QRCode = await import("qrcode");
  return QRCode.default.toDataURL(content, { margin: 1, width: 320 });
}

/**
 * Build the WhatsApp conferral setup. A linear coroutine:
 *   1. spin up the transient pairing socket,
 *   2. show each linking QR WhatsApp issues (it rotates them) as a scannable
 *      `data:` image,
 *   3. `ctx.step("paired")` — wait for the Baileys handshake to reach `open`,
 *   4. stop the transient socket, then return the terminal conferral: the
 *      in-memory session material + whatsapp profile + guardian mapping.
 * The runtime performs the single durable write from the returned conferral;
 * cancel/abandon tears the socket down and writes nothing.
 */
export function makeWhatsAppSetup(deps: {
  openPairing: () => WhatsAppPairingHandle;
  makeQrDataUrl?: (content: string) => Promise<string>;
}): SetupFn {
  const makeQrDataUrl = deps.makeQrDataUrl ?? defaultQrDataUrl;
  return async (interact, ctx) => {
    const pairing = deps.openPairing();
    let conferred = false;
    // Set once the wait ends, so a QR still rendering cannot repaint over the
    // final state; `latest` drops a slow render overtaken by a newer QR.
    let settled = false;
    let latest = "";
    pairing.onQr((qr) => {
      latest = qr;
      makeQrDataUrl(qr).then(
        (dataUrl) => {
          if (!settled && latest === qr) interact.show(whatsappQrView(dataUrl));
        },
        () => {},
      );
    });
    interact.show(whatsappPreparingView());
    try {
      const selfJid = await ctx.step("paired", async () => {
        await pairing.start();
        return pairing.waitForPaired();
      });
      settled = true;

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
      settled = true;
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
  // The WhatsApp conferral setup: show the linking QR, drive the Baileys
  // handshake over a transient in-memory socket, then land the session
  // material + profile + guardian mapping in one terminal write.
  sessionScheme.setup = makeWhatsAppSetup({ openPairing, makeQrDataUrl: deps.makeQrDataUrl });

  return {
    connectionKind: "whatsapp",
    reviveProfile: (record) => reviveWhatsAppProfile(record),
    accountIdOf: (record) => (typeof record.jid === "string" && record.jid) || null,
    grant: "session",
    auth: sessionScheme,
    capabilities: {
      talker: {
        build(cred, kit: RuntimeKit): Talker {
          const material = asSessionMaterial(cred.material as SecretRecord);
          // One auth state for the whole Talker lifetime: every socket
          // generation (initial + each reconnect) reads the SAME live record,
          // and every mutation write-throughs via kit.persist("session", …).
          const auth = createWhatsAppAuthState(material, (next) => kit.persist(next));

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

          const features: TalkFeatures = {
            inboundMedia: {
              materialize: (message) => adapter.saveIncomingAttachments(message),
            },
            // A WhatsApp direct chat is addressed by the contact's own JID,
            // so the address is already the conversation.
            directMessaging: addressIsConversationFeature(),
          };
          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onInbound(async (msg) => deliver(msg));
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
            async send(chatId, msg) {
              return adapter.send(chatId, msg);
            },
            ...features,
          };
        },
      },
    },
  };
}
