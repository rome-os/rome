// Email connection integration. Channel contract: docs/architecture/channels.md.
//
// Email is a Talker with a single `inbox` grant: the Rome Cloud-provisioned
// `<slug>@romeos.cc` address, its inbound-HMAC secret, and the guardian's
// resolved address. The transport core — outbound send, inbound HMAC verify +
// gate + body-pull + the inbound `ChannelMessage`, attachment download, history
// paging — is `EmailAdapter` (packages/core/src/channels/email.ts), wrapped here
// so the runtime's grant-epoch lifecycle and fault→grant-state mapping
// (registry.ts) drive it. The transport already speaks the channel's record, so
// inbound, send and history pass through without a projection.
//
// Unlike the polling/gateway channels, email is PUSH-driven: there is no live
// transport loop to report a terminal failure from. Two distinct signals reach
// `fault`:
//   - `ingestInbound`'s local HMAC verification fails (`bad_signature`) → the
//     inboundSecret we hold no longer matches what Rome Cloud is signing with —
//     a refused credential → CredentialRejected{ grant: "inbox" } → runtime
//     renews once (route-driven ⇒ immediate fix), then degrades.
//   - `adapter.start()` rejects → Disconnected → runtime backs off and
//     rebuilds. start() does NOT provision: the registry only ever
//     builds this adapter from complete grant material, so a start-time failure
//     is a transport/connectivity problem, never a grant problem — the `inbox`
//     credential is left untouched and the registry's own backoff loop retries
//     automatically.
//
// Provisioning is setup-driven: the `inbox` grant carries a
// near-degenerate setup — the guardian's Connect click confirms, the
// coroutine provisions the `<slug>@romeos.cc` inbox via
// `MailProvider.provision()` (get-or-create) inside `ctx.step`, and the
// terminal grant is the single ledger write. No credential ever touches the
// settings table, so `obtain()` here throws (see cross-stage notes). The first
// Rome Cloud sign-in, and the first boot of an older seat that never had email,
// make the same write without the click (`autoConnectEmail`).

import type { TalkFeatures } from "../types.js";
import {
  EMAIL_SETTINGS_KEY,
  EmailAdapter,
  type EmailInboxCoordinates,
} from "../../channels/email.js";
import type { PeopleRepository } from "../../db/repositories/people.js";
import type { SettingsRepository } from "../../db/repositories/settings.js";
import type { MailProvider } from "../../lib/rome-cloud-mail.js";
import { z } from "zod";
import type { SetupFn } from "../setup/types.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import type {
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  Talker,
} from "../types.js";
import { historyQueryLimit, historyWindowHours } from "./talk-features.js";

// The `inbox` grant's profile — the non-secret provisioned identity (the
// `<slug>@romeos.cc` address Rome Cloud minted). Declared next to the material
// shape; parse-then-store, same schema re-runs on revive (fail-closed). The
// address is the display email; the inbound HMAC secret is credential material,
// never profile. Optional so a not-yet-provisioned grant stays sparse-but-valid.
export const emailGrantProfileSchema = z
  .object({
    address: z.string().min(1).optional(),
  })
  .strict();
export type EmailGrantProfile = z.infer<typeof emailGrantProfileSchema>;

/** Pure display projection: the provisioned address IS the identity — it reads as
 *  both the display email and the handle. */
export function toEmailDisplay(profile: EmailGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: undefined,
    handle: profile.address,
    email: profile.address,
    avatarUrl: undefined,
  });
}

/** Revive a stored email profile: re-parse with the schema, then map through the
 *  pure display function (fail-closed on a record that no longer matches). */
export function reviveEmailProfile(record: ProfileRecord): ProfileDisplay {
  return toEmailDisplay(emailGrantProfileSchema.parse(record));
}

/** Parse the provisioned address into the `inbox` grant profile — the pure
 *  non-secret identity recorded alongside the credential in the SAME
 *  grant write. The connect route calls this with the
 *  freshly provisioned address; a wrong-typed value throws (fail-closed). */
export function emailGrantProfile(address: string): EmailGrantProfile {
  return emailGrantProfileSchema.parse({ address });
}

/** The `inbox` grant material (grant table): exactly the
 *  Rome Cloud-provisioned coordinates the connect route grants. `guardianEmail`
 *  is NOT here — it is durable settings config that survives revoke, sourced
 *  by the adapter from the settings row. */
export interface EmailInboxMaterial {
  address: string;
  inboundSecret: string;
}

/**
 * Runtime deps the Email adapter needs, threaded from index.ts at descriptor
 * registration time (the registry/bridge have no repo or Rome Cloud-client
 * access). Mirrors what index.ts passes to `new EmailAdapter(...)` today.
 */
export interface EmailDescriptorDeps {
  provider: MailProvider;
  settingsRepo: SettingsRepository;
  peopleRepo: PeopleRepository;
  /** Defaults to the whoami lookup (see EmailAdapter). Injectable for
   *  tests and for the descriptor-factory call site to share one resolver. */
  ownerEmailResolver?: () => Promise<string | undefined>;
  /**
   * Called synchronously right after each fresh `EmailAdapter` is built (every
   * epoch — birth, relock/re-authorize, and Disconnected backoff rebuild).
   * index.ts uses this to keep its `emailAdapterRef` (the prompt-builder's "our
   * own inbox address" lookup) pointed at the CURRENT instance — the same role
   * the old `emailAdapterRef = email` assignment played. Optional so tests don't
   * need to supply it.
   */
  onAdapterBuilt?: (adapter: EmailAdapter) => void;
}

/**
 * The `inbox` grant scheme. Grant is setup-driven: the generic
 * setup surface pumps `makeEmailSetup` and performs the terminal
 * grant — so the scheme's `obtain()` throws; `renew()` always answers
 * "needs-fix" (a refused/rotated secret needs fresh provisioning, not a
 * headless renewal).
 */
function emailInboxScheme(): AuthScheme {
  return {
    async obtain(): Promise<Credential> {
      throw new Error("grant driven by the connect setup");
    },
    async renew(): Promise<Credential | "needs-fix"> {
      return "needs-fix";
    },
  };
}

/** The narrow settings surface the email setup writes its pure-config row
 *  through (structurally satisfied by SettingsRepository; tests fake it). */
export interface EmailSetupSettings {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

/** Write the pure-config settings row `{ enabled: true }` for a freshly
 *  provisioned inbox and return its terminal grant. Call it BEFORE the
 *  grant is committed: the epoch build that commit triggers starts the
 *  adapter, which reads this row. `guardianEmail` survives (amendment 2), and
 *  stale pre-4c credential fields are stripped so the row never carries a
 *  credential. */
async function emailGrant(
  settings: EmailSetupSettings,
  inbox: EmailInboxMaterial,
): Promise<{ credential: Credential; profile: EmailGrantProfile }> {
  const existing = (await settings.get<Record<string, unknown>>(EMAIL_SETTINGS_KEY)) ?? {};
  const { address: _address, inboundSecret: _inboundSecret, ...config } = existing;
  await settings.set(EMAIL_SETTINGS_KEY, { ...config, enabled: true });
  return {
    credential: {
      material: { address: inbox.address, inboundSecret: inbox.inboundSecret },
      expiresAt: "never",
    },
    profile: emailGrantProfile(inbox.address),
  };
}

/**
 * Build the Email setup. Near-degenerate: the
 * guardian's Connect click is the confirmation, so the coroutine is linear:
 *   1. show the provisioning progress view,
 *   2. `ctx.step("provision")` — the Rome Cloud mail provision (get-or-create;
 *      a cancel interrupts the wait and leaves zero durable state),
 *   3. persist the pure-config settings row (see `emailGrant`),
 *   4. return the terminal grant: the provisioned coordinates as the
 *      `inbox` material + the address as the grant profile.
 *
 * The old connect route compensated the config write when its grant threw;
 * this setup deliberately doesn't. `enabled: true` over no grant is benign and
 * ordinary post-cutover (the registry-native teardown never touches the row
 * either): pure-config rows hydrate nothing at boot, adapters start only from
 * grant epochs, and retrying the failed setup converges.
 */
export function makeEmailSetup(deps: {
  provision: () => Promise<EmailInboxMaterial>;
  settings: EmailSetupSettings;
}): SetupFn {
  return async (interact, ctx) => {
    interact.show({
      title: "Setting up email",
      body: ["Provisioning your Rome email address…"],
      progress: true,
    });
    const inbox = await ctx.step("provision", () => deps.provision());
    const { credential, profile } = await emailGrant(deps.settings, inbox);
    return {
      credential,
      profile,
      summary: {
        title: "Email connected",
        body: [`Your agent's address is ${inbox.address}.`],
      },
    };
  };
}

/** The narrow registry surface `autoConnectEmail` drives. Every
 *  `ConnectionRegistry` satisfies it structurally. */
export interface EmailAutoConnectRegistry {
  find(connectionKind: string): readonly unknown[];
  withGrantSection<T>(connectionKind: string, grant: string, fn: () => Promise<T>): Promise<T>;
  giveGrant(
    connectionKind: string,
    connectionId: string | undefined,
    grant: string,
    credential: Credential,
    profile: ProfileRecord | undefined,
  ): Promise<unknown>;
}

/**
 * Connect email without the guardian's Connect click: provision the inbox and
 * grant the `inbox` grant, the same terminal write the setup makes.
 *
 * Resolves `false` and provisions nothing when the instance has ever had email:
 * an email connection exists in any grant state, or the email settings row
 * exists. Every grant writes that row and nothing deletes it, so it outlives
 * a connection the guardian disconnected, and a disconnected one is never
 * reconnected. Resolves `true` once the grant is granted. Rejects when
 * the provision or the grant fails. A failed provision writes nothing, so a
 * later call retries; a failed grant has already written the row, so only
 * the guardian's Connect click retries it.
 */
export async function autoConnectEmail(deps: {
  registry: EmailAutoConnectRegistry;
  provision: () => Promise<EmailInboxMaterial>;
  settings: EmailSetupSettings;
}): Promise<boolean> {
  const hasHadEmail = async () =>
    deps.registry.find("email").length > 0 ||
    (await deps.settings.get(EMAIL_SETTINGS_KEY)) !== null;
  if (await hasHadEmail()) return false;
  const inbox = await deps.provision();
  return deps.registry.withGrantSection("email", "inbox", async () => {
    // The provision ran outside the section, so the guardian can have
    // connected, and even removed, email meanwhile. Re-check under the section
    // the setup commits in.
    if (await hasHadEmail()) return false;
    const { credential, profile } = await emailGrant(deps.settings, inbox);
    await deps.registry.giveGrant("email", undefined, "inbox", credential, profile);
    return true;
  });
}

/**
 * Build the Email descriptor. `deps` carries the adapter's runtime
 * dependencies (Rome Cloud mail client, settings/person-mapping repos) so the
 * wire stage can thread them from index.ts where they're constructed.
 */
export function makeEmailDescriptor(deps: EmailDescriptorDeps): ConnectionDescriptor {
  const inboxScheme = emailInboxScheme();
  // The one-click provision setup: confirm (the Connect click) →
  // provision the Rome Cloud inbox → single terminal write of the provisioned
  // coordinates + address profile.
  inboxScheme.setup = makeEmailSetup({
    provision: () => deps.provider.provision(),
    settings: deps.settingsRepo,
  });

  return {
    connectionKind: "email",
    reviveProfile: (record) => reviveEmailProfile(record),
    accountIdOf: (record) => (typeof record.address === "string" && record.address) || null,
    grant: "inbox",
    auth: inboxScheme,
    capabilities: {
      talker: {
        history: true,
        build(cred, kit): Talker {
          const material = cred.material as unknown as EmailInboxMaterial;
          const config: EmailInboxCoordinates = {
            address: material.address,
            inboundSecret: material.inboundSecret,
          };
          const adapter = new EmailAdapter({
            provider: deps.provider,
            settingsRepo: deps.settingsRepo,
            peopleRepo: deps.peopleRepo,
            config,
            ownerEmailResolver: deps.ownerEmailResolver,
          });
          deps.onAdapterBuilt?.(adapter);

          let faultSink: ((err: CredentialRejected | Disconnected) => void) | null = null;
          let unregisterIngress: (() => void) | null = null;

          const features: TalkFeatures = {
            inboundMedia: {
              materialize: (message) => adapter.saveIncomingAttachments(message),
            },
            history: {
              async query(input) {
                const messages = await adapter.fetchHistory(
                  input.chatId ?? null,
                  historyWindowHours(input.since),
                );
                return messages.slice(0, historyQueryLimit(input.limit));
              },
            },
          };
          return {
            start(deliver, fault): void {
              faultSink = fault;
              adapter.onInbound(async (msg) => deliver(msg));
              unregisterIngress = kit.registerIngress(async (input) => {
                const deposit = input as { rawBody?: unknown; signature?: unknown };
                if (typeof deposit.rawBody !== "string" || typeof deposit.signature !== "string") {
                  throw new Error("Invalid email ingress payload");
                }
                const result = await adapter.ingestInbound(deposit.rawBody, deposit.signature);
                if (result.status === "rejected" && result.reason === "bad_signature") {
                  faultSink?.(new CredentialRejected({ grant: "inbox" }));
                }
                return result;
              });
              // start() only touches the network for the guardian-email best-
              // effort resolve (already try/catch'd inside EmailAdapter — never
              // rejects) and — defensively, should the grant material ever be
              // incomplete — the provisioning fallback. Either way, a rejection
              // here is a Rome Cloud connectivity problem, never a credential
              // problem: route it to Disconnected so the registry backs off and
              // retries instead of degrading the (perfectly valid) inbox grant.
              adapter.start().catch((err) => faultSink?.(new Disconnected(err)));
            },
            stop(): Promise<void> {
              unregisterIngress?.();
              unregisterIngress = null;
              return adapter.stop();
            },
            send(chatId, msg) {
              return adapter.send(chatId, msg);
            },
            ...features,
          };
        },
      },
    },
  };
}
