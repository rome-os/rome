import { requestSignerToken, SignerError, signerHealth } from "@rome-os/node-core/signer";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";
import { createLogger } from "../logger.js";
import { type CloudProfile, readCloudProfile } from "./cloud-profile.js";
import { readEnvInstanceToken } from "./instance-env.js";

const log = createLogger("instance-identity");

// Must match Rome Cloud's INSTANCE_TOKEN_PREFIX. Distinct from the
// `rome_` account/CLI token so neither verifier mistakes one for the other.
const INSTANCE_TOKEN_PREFIX = "romeinst_";

// The DB key (in the `settings` table) that holds the durable instance token.
export const INSTANCE_TOKEN_SETTING_KEY = "instanceToken";

// The DB key holding the thumbprint of the signer key Rome Cloud has registered
// for this instance. Only set in signer mode, where its presence replaces the
// instance token as the "linked" signal.
export const INSTANCE_KEY_SETTING_KEY = "instanceKeyId";

// The minimal settings reader/writer this module needs. `SettingsRepository`
// satisfies it; keeping the surface narrow lets instance-identity stay free of
// DB/Drizzle types.
export interface InstanceTokenStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function isValidInstanceToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.startsWith(INSTANCE_TOKEN_PREFIX);
}

// The durable instance credential. The DB is the single runtime
// read path: a provisioned VM gets the token injected into the env via
// cloud-init and seeds it into the DB at boot (see `seedInstanceTokenFromEnv`);
// the desktop/local app mints it through the in-app OAuth flow and persists it
// the same way. `getInstanceToken` only ever reads the in-memory cache that
// `hydrateInstanceToken` fills from the DB — it never touches the env.
let cachedInstanceToken: string | null = null;
let cachedKeyId: string | null = null;
const instanceTokenListeners = new Set<() => void>();

/** The signer's unix socket path, or null in legacy mode. */
export function signerSocketPath(): string | null {
  return process.env.ROME_SIGNER_SOCKET?.trim() || null;
}

/** True when a signer service is configured: Rome Cloud calls carry signer tokens, not the instance token. */
export function signerMode(): boolean {
  return signerSocketPath() !== null;
}

/** Only the legacy path and the signer registration read this. Everything else uses `cloudBearer`. */
export function getInstanceToken(): string | null {
  return isValidInstanceToken(cachedInstanceToken) ? cachedInstanceToken : null;
}

/**
 * Whether Rome Cloud knows this instance: a durable instance token in legacy
 * mode, a registered signer key in signer mode.
 */
export function isInstanceLinked(): boolean {
  return signerMode() ? cachedKeyId !== null : getInstanceToken() !== null;
}

/**
 * A stable name for the credential `cloudBearer` presents: the signer key's
 * thumbprint in signer mode, the instance token otherwise. Null when not linked.
 * Signer tokens change every call, so use this where the credential's identity matters.
 */
export function instanceCredentialId(): string | null {
  return signerMode() ? cachedKeyId : getInstanceToken();
}

// A signer token lives 60 seconds. One is reused until 15 seconds before it
// expires, and concurrent callers share one signer request. The generation
// stops a request that was in flight when the cache was cleared from refilling it.
const BEARER_REFRESH_MARGIN_MS = 15_000;
let bearerCache: { token: string; reuseUntil: number } | null = null;
let bearerInFlight: Promise<string> | null = null;
let bearerGeneration = 0;

function clearBearerCache(): void {
  bearerCache = null;
  bearerInFlight = null;
  bearerGeneration++;
}

function tokenExpiryMs(token: string): number {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function signerBearer(socket: string): Promise<string> {
  if (bearerCache && Date.now() < bearerCache.reuseUntil) return Promise.resolve(bearerCache.token);
  if (bearerInFlight) return bearerInFlight;
  const generation = bearerGeneration;
  const request: Promise<string> = requestSignerToken(socket)
    .then((token) => {
      if (generation === bearerGeneration) {
        bearerCache = { token, reuseUntil: tokenExpiryMs(token) - BEARER_REFRESH_MARGIN_MS };
      }
      return token;
    })
    .finally(() => {
      if (bearerInFlight === request) bearerInFlight = null;
    });
  bearerInFlight = request;
  return request;
}

// The instance token a signer-mode instance can still offer before its key is
// registered. A token that registration found unusable is not offered again.
let rejectedInstanceToken: string | null = null;
function unregisteredInstanceToken(): string | null {
  const token = getInstanceToken() ?? envInstanceToken();
  return token !== rejectedInstanceToken ? token : null;
}

/**
 * The bearer for a Rome Cloud call, or null when there is none to offer.
 * Legacy mode returns the instance token. Signer mode returns a signer token,
 * reused until shortly before it expires, once the key is registered; until
 * then it returns the instance token if one is still usable, so an upgrade has
 * no outage. A signer that cannot be reached returns null.
 */
export async function cloudBearer(): Promise<string | null> {
  const socket = signerSocketPath();
  if (!socket) return getInstanceToken();
  if (cachedKeyId === null) return unregisteredInstanceToken();
  try {
    return await signerBearer(socket);
  } catch (err) {
    log.warn("signer token unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function notifyLinkChanged(): void {
  // The state is already persisted; a failing listener must not fail that write.
  for (const listener of instanceTokenListeners) {
    try {
      listener();
    } catch (err) {
      log.warn("instance token listener failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Update the in-process cache without touching the DB. Call after persisting a
// freshly-minted token so synchronous `getInstanceToken` callers see it at once.
export function setInstanceTokenInMemory(token: string | null): void {
  const nextToken = isValidInstanceToken(token) ? token : null;
  if (cachedInstanceToken === nextToken) return;
  cachedInstanceToken = nextToken;
  notifyLinkChanged();
}

async function setKeyId(store: InstanceTokenStore, keyId: string | null): Promise<void> {
  if (cachedKeyId === keyId) return;
  clearBearerCache();
  if (keyId) await store.set(INSTANCE_KEY_SETTING_KEY, keyId);
  else await store.delete(INSTANCE_KEY_SETTING_KEY);
  cachedKeyId = keyId;
  notifyLinkChanged();
}

/** Subscribe to changes in whether this instance is linked to Rome Cloud. */
export function onInstanceTokenChanged(listener: () => void): () => void {
  instanceTokenListeners.add(listener);
  return () => instanceTokenListeners.delete(listener);
}

// Load the persisted token from the DB into the cache. Run once at boot, before
// anything calls `getInstanceToken`.
export async function hydrateInstanceToken(store: InstanceTokenStore): Promise<void> {
  const keyId = await store.get<string>(INSTANCE_KEY_SETTING_KEY);
  cachedKeyId = typeof keyId === "string" ? keyId : null;
  clearBearerCache();
  rejectedInstanceToken = null;
  offeredHostedTokens.clear();
  hostedLinkUnsupported = false;
  const stored = await store.get<string>(INSTANCE_TOKEN_SETTING_KEY);
  setInstanceTokenInMemory(stored ?? null);
}

// The token a hosted `.env` injects. Dev can ignore it to boot un-enrolled.
function envInstanceToken(): string | null {
  const envToken = readEnvInstanceToken();
  return isValidInstanceToken(envToken) ? envToken : null;
}

// Cloud-only seeding: a provisioned VM gets `ROME_INSTANCE_TOKEN` injected into
// its env. Persist it to the DB so the runtime has one read path. Upserts on
// every boot so a rotated env token propagates. Desktop/local have no env token
// and fall through to the in-app enroll flow. Returns whether a token was seeded.
// Signer mode never seeds: the env token is only offered to key registration.
export async function seedInstanceTokenFromEnv(store: InstanceTokenStore): Promise<boolean> {
  const envToken = envInstanceToken();
  if (signerMode() || !envToken) return false;
  await store.set(INSTANCE_TOKEN_SETTING_KEY, envToken);
  return true;
}

// Persist a freshly-minted token (from the in-app OAuth enroll flow) and refresh
// the cache so it takes effect without a restart. In signer mode the token is
// only a one-time proof: it registers the signer key right away and is deleted.
// Returns the registration result in signer mode, null in legacy mode.
export async function persistInstanceToken(
  store: InstanceTokenStore,
  token: string,
): Promise<ProveIdentityResult | null> {
  await store.set(INSTANCE_TOKEN_SETTING_KEY, token);
  setInstanceTokenInMemory(token);
  return signerMode() ? syncInstanceIdentity(store) : null;
}

// Fail closed on a token Rome Cloud has rejected (revoked/unknown): drop it from
// the DB and the cache so `getInstanceToken` returns null, `instanceEnrolled`
// flips false, and the web routes back to the connect flow. Used by the identity
// heartbeat and any caller that observes a terminal auth signal. In signer mode
// it also forgets the registered key, because the caller has seen the instance rejected.
export async function clearInstanceToken(store: InstanceTokenStore): Promise<void> {
  await dropStoredToken(store);
  await setKeyId(store, null);
}

async function dropStoredToken(store: InstanceTokenStore): Promise<void> {
  await store.delete(INSTANCE_TOKEN_SETTING_KEY);
  setInstanceTokenInMemory(null);
}

export interface InstanceIdentity {
  accountId: string;
  instanceId: string;
  /** The account owner's email (the guardian's, from signup). Present whenever
   *  Rome Cloud's whoami returns it; used to seed the email channel's guardian
   *  gate without manual entry. */
  email?: string;
  /** Rome Cloud profile picture for the account owner. Null means Cloud knows
   *  the account has no picture; undefined means the response omitted the field. */
  avatarUrl?: string | null;
  /** The slug of the Pantheon-hosted Rome this credential is the provisioned one
   *  of, as whoami names it. Absent when whoami says null or, from an older Rome
   *  Cloud, omits it: either way this is not a hosted instance. */
  hostedSlug?: string;
  /** The whole whoami account, for `system:get_guardian_cloud_profile`. */
  profile?: CloudProfile;
}

// The outcome of presenting the durable token to Rome Cloud. `revoked` and
// `unknown` mirror the server's terminal signals: both mean "this
// instance is no longer valid," distinguished only so a caller can tell a
// tombstone (403) from a never-known/garbled token (401). `no_token` and
// `unconfigured` are local preconditions (not enrolled / no Rome Cloud origin);
// `unreachable` is a transient network failure — the only non-terminal miss.
//
// Five more states are faults the guardian can fix, and none of them is
// terminal: `key_conflict` (the instance registered a different signer key, so
// it needs a new sign-in), `clock_skew` (the host clock is off by more than two
// minutes), `signer_unavailable` (the signer does not answer),
// `audience_mismatch` (the signer issues tokens for another Rome Cloud address)
// and `upgrade_required` (Rome Cloud retired the instance token in favor of a
// signer key this deployment does not have).
export type ProveIdentityResult =
  | { status: "ok"; identity: InstanceIdentity }
  | { status: "revoked" }
  | { status: "unknown" }
  | { status: "no_token" }
  | { status: "unconfigured" }
  | { status: "unreachable" }
  | { status: IdentityIssue };

export type IdentityIssue =
  | "key_conflict"
  | "clock_skew"
  | "signer_unavailable"
  | "audience_mismatch"
  | "upgrade_required";

const IDENTITY_ISSUE_MESSAGES: Record<IdentityIssue, string> = {
  key_conflict: "This instance's credential was registered elsewhere. Sign in again.",
  clock_skew: "System clock is off.",
  signer_unavailable: "Signing service is not running.",
  audience_mismatch: "The signing service is configured for a different Rome Cloud address.",
  upgrade_required: "Update your compose file to add the signer service.",
};

let identityIssue: IdentityIssue | null = null;

/** The fault the last identity check found, with one short message for the guardian, or null. */
export function getIdentityIssue(): { state: IdentityIssue; message: string } | null {
  return identityIssue
    ? { state: identityIssue, message: IDENTITY_ISSUE_MESSAGES[identityIssue] }
    : null;
}

export interface ProveIdentityOptions {
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Present only for the one boot-time announcement. Recurring identity
   *  heartbeats omit it, so Rome Cloud can distinguish boots from liveness. */
  bootVersion?: string | null;
}

// The single client-side seam: present the instance's credential to Rome Cloud
// and learn who we are. The credential is a fresh signer token in signer mode
// (even before the key is registered, since a 200 is what proves it is) and the
// durable instance token otherwise. It is presented ONLY to Rome Cloud, never
// to a service edge.
export async function proveIdentity(opts: ProveIdentityOptions = {}): Promise<ProveIdentityResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const socket = signerSocketPath();
  let token: string | null;
  try {
    token = socket ? await requestSignerToken(socket) : getInstanceToken();
  } catch {
    return { status: "signer_unavailable" };
  }
  if (!token) return { status: "no_token" };

  const origin = getRomeCloudOrigin();
  if (!origin) return { status: "unconfigured" };

  let response: Response;
  try {
    const isBootAnnouncement = Object.hasOwn(opts, "bootVersion");
    response = await fetchImpl(new URL("/api/instance/whoami", origin), {
      method: isBootAnnouncement ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Cache-Control": "no-store",
        ...(isBootAnnouncement ? { "Content-Type": "application/json" } : {}),
      },
      ...(isBootAnnouncement ? { body: JSON.stringify({ version: opts.bootVersion }) } : {}),
      cache: "no-store",
    });
  } catch {
    // Network failure — non-terminal. The caller retries later; we never treat
    // an unreachable Rome Cloud as "not this instance."
    return { status: "unreachable" };
  }

  if (socket && (response.status === 401 || response.status === 403)) clearBearerCache();
  if (response.status === 401)
    return (await isClockSkew(response)) ? { status: "clock_skew" } : { status: "unknown" };
  if (response.status === 403) return { status: "revoked" };
  if (response.status === 426) return { status: "upgrade_required" };
  if (!response.ok) return { status: "unreachable" };

  const data = (await response.json().catch(() => null)) as {
    instanceId?: unknown;
    hostedSlug?: unknown;
    account?: { id?: unknown; email?: unknown; avatarUrl?: unknown } | null;
  } | null;
  const instanceId = typeof data?.instanceId === "string" ? data.instanceId : null;
  const accountId = typeof data?.account?.id === "string" ? data.account.id : null;
  if (!instanceId || !accountId) return { status: "unreachable" };
  const email = typeof data?.account?.email === "string" ? data.account.email : undefined;
  const avatarUrl =
    data?.account && Object.hasOwn(data.account, "avatarUrl")
      ? typeof data.account.avatarUrl === "string"
        ? data.account.avatarUrl
        : null
      : undefined;

  const hostedSlug = typeof data?.hostedSlug === "string" ? data.hostedSlug : undefined;

  return {
    status: "ok",
    identity: {
      accountId,
      instanceId,
      email,
      avatarUrl,
      ...(hostedSlug === undefined ? {} : { hostedSlug }),
      profile: readCloudProfile(data?.account),
    },
  };
}

async function isClockSkew(response: Response): Promise<boolean> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === "clock_skew";
}

// Offers the instance token to Rome Cloud once, together with a signer token
// proving the signer's key. Cloud stores the key and retires the instance token,
// and a repeat with the same key succeeds again, so a lost response is safe to retry.
async function registerInstanceKey(
  socket: string,
  fetchImpl: typeof fetch,
): Promise<"registered" | Exclude<ProveIdentityResult["status"], "ok">> {
  const instanceToken = getInstanceToken() ?? envInstanceToken();
  if (!instanceToken) return "no_token";
  const origin = getRomeCloudOrigin();
  if (!origin) return "unconfigured";
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/instance/key", origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${instanceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ assertion: await requestSignerToken(socket) }),
      cache: "no-store",
    });
  } catch (err) {
    return err instanceof SignerError ? "signer_unavailable" : "unreachable";
  }
  if (response.ok) return "registered";
  if (response.status === 401 || response.status === 403) clearBearerCache();
  if (response.status === 401 && (await isClockSkew(response))) return "clock_skew";
  if (response.status === 401 || response.status === 403 || response.status === 409) {
    rejectedInstanceToken = instanceToken;
    return response.status === 401
      ? "unknown"
      : response.status === 403
        ? "revoked"
        : "key_conflict";
  }
  log.warn("instance key registration failed", { status: response.status });
  return "unreachable";
}

const IDENTITY_RETRY_MS = 30_000;
let identityRetry: ReturnType<typeof setTimeout> | undefined;
const linkedListeners = new Set<() => void>();

// The signer must issue tokens for the Rome Cloud this instance talks to.
// Otherwise Cloud answers 401, which must not be mistaken for an unknown instance.
async function audienceMatches(socket: string): Promise<boolean> {
  const origin = getRomeCloudOrigin();
  return origin === null || (await signerHealth(socket)).aud === origin;
}

// The identity check every trigger runs (boot, heartbeat, right after sign-in).
// Legacy mode is `proveIdentity` plus the state it reports. Signer mode also
// links the instance: a 200 with a signer token means Cloud holds the key; a
// 401 with an instance token on hand registers the key; a 401 without one means
// sign in. Faults the guardian must fix keep every credential and recheck every
// 30 seconds, and so does an unreachable Rome Cloud while an instance token still
// waits to be registered. Never rejects.
export async function syncInstanceIdentity(
  store: InstanceTokenStore,
  opts: ProveIdentityOptions = {},
): Promise<ProveIdentityResult> {
  const socket = signerSocketPath();
  let result: ProveIdentityResult;
  try {
    if (socket && !(await audienceMatches(socket))) {
      result = { status: "audience_mismatch" };
    } else {
      result = await proveIdentity(opts);
      if (socket) result = await linkSignerKey(store, socket, opts, result);
    }
  } catch (err) {
    if (!(err instanceof SignerError)) throw err;
    result = { status: "signer_unavailable" };
  }
  identityIssue = Object.hasOwn(IDENTITY_ISSUE_MESSAGES, result.status)
    ? (result.status as IdentityIssue)
    : null;
  clearTimeout(identityRetry);
  const waitingToRegister =
    result.status === "unreachable" &&
    socket !== null &&
    cachedKeyId === null &&
    (getInstanceToken() ?? envInstanceToken()) !== null;
  if (
    waitingToRegister ||
    result.status === "clock_skew" ||
    result.status === "signer_unavailable" ||
    result.status === "audience_mismatch"
  ) {
    identityRetry = setTimeout(() => void recheckInstanceIdentity(store), IDENTITY_RETRY_MS);
    identityRetry.unref?.();
  }
  return result;
}

/** Subscribe to a background identity check that links an instance that was not linked. */
export function onInstanceLinked(listener: () => void): () => void {
  linkedListeners.add(listener);
  return () => linkedListeners.delete(listener);
}

/** The check the heartbeat and the 30-second retry run. Tells `onInstanceLinked` listeners when it links. */
export async function recheckInstanceIdentity(
  store: InstanceTokenStore,
): Promise<ProveIdentityResult> {
  const wasLinked = isInstanceLinked();
  const result = await syncInstanceIdentity(store);
  if (!wasLinked && isInstanceLinked()) {
    for (const listener of linkedListeners) {
      try {
        listener();
      } catch (err) {
        log.warn("instance linked listener failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

// Instance tokens this process has offered for a hosted link, so the heartbeat
// does not offer the same one again. A 404 means this Rome Cloud has no
// hosted-link endpoint yet, so nothing is offered again until the next boot.
const offeredHostedTokens = new Set<string>();
let hostedLinkUnsupported = false;

// The signer already authenticates as the credential it is bound to, while an
// instance token is still on hand. That token may be a fresh hosted enrollment
// for this box. Rome Cloud then moves its hosted link onto the credential in
// use, so Rome Cloud lists this hosted instance through it, and retires the
// token. Returns whether to keep the token for a later attempt.
async function offerHostedLink(socket: string, fetchImpl: typeof fetch): Promise<boolean> {
  const token = unregisteredInstanceToken();
  const origin = getRomeCloudOrigin();
  if (!token || !origin || offeredHostedTokens.has(token)) return false;
  // Held for the boot after Rome Cloud deploys the endpoint.
  if (hostedLinkUnsupported) return true;
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/instance/key/hosted-link", origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ assertion: await requestSignerToken(socket) }),
      cache: "no-store",
    });
  } catch {
    return true;
  }
  if (response.status === 404) {
    hostedLinkUnsupported = true;
    log.info("Rome Cloud has no hosted-link endpoint yet; keeping the instance token");
    return true;
  }
  if (response.status >= 500) return true;
  if (response.status === 401 && (await isClockSkew(response.clone()))) return true;
  offeredHostedTokens.add(token);
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (response.ok) {
    log.info("hosted link moved to the credential in use");
    return false;
  }
  const error = typeof body?.error === "string" ? body.error : null;
  // The token already holds a key, or no credential holds this one: the usual
  // registration handles both. It answers ok when the token is this box's own.
  if (response.status === 409 && (error === "already_bound" || error === "key_not_registered")) {
    const registered = await registerInstanceKey(socket, fetchImpl);
    if (registered !== "registered") log.info("hosted enrollment not registered", { registered });
    return false;
  }
  if (error === "account_mismatch") {
    log.warn("security event: hosted enrollment for another account", {
      event: "hosted_link_account_mismatch",
    });
  } else {
    log.info("hosted enrollment not linked", { status: response.status, error });
  }
  return false;
}

async function linkSignerKey(
  store: InstanceTokenStore,
  socket: string,
  opts: ProveIdentityOptions,
  first: ProveIdentityResult,
): Promise<ProveIdentityResult> {
  const link = async () => {
    await setKeyId(store, (await signerHealth(socket)).jkt);
    await dropStoredToken(store);
  };
  if (first.status === "ok") {
    const keep = await offerHostedLink(socket, opts.fetch ?? globalThis.fetch);
    await setKeyId(store, (await signerHealth(socket)).jkt);
    if (!keep) await dropStoredToken(store);
    return first;
  }
  if (first.status !== "unknown" && first.status !== "revoked") return first;

  await setKeyId(store, null);
  const registered = await registerInstanceKey(socket, opts.fetch ?? globalThis.fetch);
  if (registered === "registered") {
    await link();
    return proveIdentity(opts);
  }
  if (registered === "no_token") return first;
  // A token Cloud rejected, or a key it holds for another signer, helps no later attempt.
  if (registered === "unknown" || registered === "revoked" || registered === "key_conflict")
    await dropStoredToken(store);
  if (registered === "key_conflict")
    log.warn("security event: instance key registered elsewhere", { event: "key_conflict" });
  return { status: registered } as ProveIdentityResult;
}

// Best-effort identity announcement at boot. Authenticate is "constant,
// invisible" — a single prove at startup gives operators
// visibility into which account this instance is bound to and bumps the
// server's `lastSeen`. Never blocks or fails boot. Returns the prove result so
// the caller can record the bound account from this one check instead of
// proving a second time.
export async function logInstanceIdentityAtBoot(
  store: InstanceTokenStore,
  version: string | null,
): Promise<ProveIdentityResult> {
  try {
    const result = await syncInstanceIdentity(store, { bootVersion: version });
    switch (result.status) {
      case "ok":
        log.info("instance enrolled", { instanceId: result.identity.instanceId });
        break;
      case "no_token":
        log.info("instance not enrolled (no instance token present)");
        break;
      case "unconfigured":
        log.debug("instance token present but Rome Cloud origin not configured");
        break;
      case "unreachable":
        log.warn("could not reach Rome Cloud to verify instance identity");
        break;
      case "unknown":
      case "revoked":
        // Terminal server signals. A provisioned/desktop client that owns the
        // token store would clear it here; core only holds an injected env var,
        // so it just surfaces the state loudly for operators.
        log.warn("instance token rejected by Rome Cloud", { reason: result.status });
        break;
      case "key_conflict":
      case "clock_skew":
      case "signer_unavailable":
      case "audience_mismatch":
      case "upgrade_required":
        log.warn("instance identity needs attention", { reason: result.status });
        break;
    }
    return result;
  } catch (err) {
    log.warn("instance identity check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "unreachable" };
  }
}
