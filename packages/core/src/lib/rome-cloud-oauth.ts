import { createHash, randomBytes } from "node:crypto";
import { RenewalUnavailable } from "../connections/errors.js";
import { eq, lt } from "drizzle-orm";
import { oauthPendingAttempts } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { getInstanceToken } from "./instance-identity.js";
import { getInstanceOrigin, getRomeCloudOrigin } from "./rome-cloud-origin.js";
import { isOAuthProvider, SHOPIFY_INSTALL_URL, type OAuthProvider } from "./oauth-providers.js";
import type { OAuthTokenBundle } from "./oauth-token-bundle.js";

// RFC 8693 token-exchange grant. The brokering STS at Rome Cloud's
// /connections/token speaks this grant; the subject token is the
// single-use handoff minted at the provider callback.
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const HANDOFF_TOKEN_TYPE = "urn:rome:params:oauth:token-type:handoff";

export interface RomeCloudOAuthProviderLink {
  provider: OAuthProvider;
  connectUrl: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface RomeCloudOAuthRedeemResponse {
  provider: OAuthProvider;
  /** Raw profile JSON from Rome Cloud. Never consumed as-is: each service parses
   *  it against its own schema before anything is stored. */
  profile?: Record<string, unknown> | null;
  tokens: OAuthTokenBundle;
  metadata?: Record<string, unknown> | null;
}

const PENDING_ATTEMPT_TTL_MS = 10 * 60 * 1000;

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateOpaqueCode(size = 32): string {
  return toBase64Url(randomBytes(size));
}

function createPkceVerifier(): string {
  return generateOpaqueCode(48);
}

function createPkceChallenge(verifier: string): string {
  return toBase64Url(createHash("sha256").update(verifier).digest());
}

export function createRomeCloudOAuthStartUrl(provider: OAuthProvider): RomeCloudOAuthProviderLink {
  if (!getRomeCloudOrigin()) {
    return {
      provider,
      connectUrl: null,
      available: false,
      unavailableReason: "Rome Cloud origin is not configured for this instance.",
    };
  }

  // Available whenever Rome Cloud is reachable. The connect link is the instance's
  // own start route as a same-origin relative path — the browser resolves it
  // against the dashboard origin, which is exactly where that route lives. No
  // request needed. Shopify authorizes per store and Shopify's App Store rules
  // forbid asking the merchant to type it, so its link is Shopify's install
  // link, where Shopify asks which store.
  return {
    provider,
    connectUrl: provider === "shopify" ? SHOPIFY_INSTALL_URL : `/api/oauth/${provider}/start`,
    available: true,
    unavailableReason: null,
  };
}

export async function createRomeCloudOAuthStartRedirect(
  db: DrizzleDb,
  provider: OAuthProvider,
  opts?: { reconnect?: boolean; shop?: string },
): Promise<string> {
  const romeCloudOrigin = getRomeCloudOrigin();
  if (!romeCloudOrigin) {
    throw new Error("Rome Cloud origin is not configured for this instance.");
  }

  const now = new Date();
  await db.delete(oauthPendingAttempts).where(lt(oauthPendingAttempts.expiresAt, now));

  // The instance's own callback origin, stated authoritatively (not inferred
  // from the request) — Rome Cloud returns the connection handoff here.
  const callbackOrigin = getInstanceOrigin();
  const state = generateOpaqueCode(24);
  const codeVerifier = createPkceVerifier();
  const codeChallenge = createPkceChallenge(codeVerifier);

  // `tenant` is persisted as "" — the column is NOT NULL but unused; the
  // redeeming instance is identified by its instance token, not the tenant.
  await db.insert(oauthPendingAttempts).values({
    state,
    provider,
    tenant: "",
    callbackOrigin,
    codeVerifier,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PENDING_ATTEMPT_TTL_MS),
  });

  // Front-channel authorize. Rome Cloud takes the account from the dashboard cookie
  // and returns the handoff to `callbackOrigin`; no tenant is sent.
  const authorizeUrl = new URL(`/connections/${provider}/authorize`, romeCloudOrigin);
  authorizeUrl.searchParams.set("callbackOrigin", callbackOrigin);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  // A reconnect asks Rome Cloud to re-run the provider authorization from scratch
  // (full re-consent) and replace the stored grant, rather than reusing the token
  // on the existing connection.
  if (opts?.reconnect) {
    authorizeUrl.searchParams.set("reconnect", "1");
  }
  // Shopify authorizes per store; Rome Cloud validates the domain and builds the
  // store's own authorize URL from it.
  if (opts?.shop) {
    authorizeUrl.searchParams.set("shop", opts.shop);
  }

  return authorizeUrl.toString();
}

export async function redeemRomeCloudOAuthHandoff(
  db: DrizzleDb,
  handoff: string,
  state: string,
): Promise<RomeCloudOAuthRedeemResponse> {
  const romeCloudOrigin = getRomeCloudOrigin();
  if (!romeCloudOrigin) {
    throw new Error("Rome Cloud origin is not configured for OAuth redemption.");
  }

  // The instance authenticates the back-channel leg with its enrolled
  // token. Without an enrolled token there is no caller identity to broker
  // on behalf of.
  const instanceToken = getInstanceToken();
  if (!instanceToken) {
    throw new Error("This instance is not enrolled with Rome Cloud.");
  }

  const [pendingAttempt] = await db
    .select()
    .from(oauthPendingAttempts)
    .where(eq(oauthPendingAttempts.state, state))
    .limit(1);

  if (
    !pendingAttempt ||
    pendingAttempt.consumedAt ||
    pendingAttempt.expiresAt.getTime() < Date.now()
  ) {
    throw new Error("OAuth state is invalid or expired.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Authorization: `Bearer ${instanceToken}`,
  };

  const response = await fetch(new URL("/connections/token", romeCloudOrigin), {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: handoff,
      subject_token_type: HANDOFF_TOKEN_TYPE,
      code_verifier: pendingAttempt.codeVerifier,
    }),
  });

  const data = (await response.json().catch(() => null)) as
    | (Partial<RomeCloudOAuthRedeemResponse> & { error?: string; error_description?: string })
    | null;

  if (!response.ok) {
    // Prefer the human-readable description — the bare RFC 6749 code (e.g.
    // "invalid_grant") ends up verbatim on the dashboard's /callback screen.
    throw new Error(
      data?.error_description ||
        data?.error ||
        `Rome Cloud handoff redeem failed with status ${response.status}.`,
    );
  }

  if (
    !data ||
    typeof data.provider !== "string" ||
    !isOAuthProvider(data.provider) ||
    !data.tokens
  ) {
    throw new Error("Rome Cloud returned an invalid OAuth redemption payload.");
  }

  if (data.provider !== pendingAttempt.provider) {
    throw new Error(
      "Rome Cloud returned an OAuth provider that does not match the pending attempt.",
    );
  }

  await db
    .update(oauthPendingAttempts)
    .set({ consumedAt: new Date() })
    .where(eq(oauthPendingAttempts.state, state));

  return {
    provider: data.provider,
    profile: data.profile,
    tokens: data.tokens,
    metadata:
      data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : null,
  };
}

/** How long a refresh may take. It runs under the grant's lock and at boot. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Renew an expiring provider grant through Rome Cloud. Rome Cloud holds the
 * provider client secret, so it runs the refresh and answers with the
 * replacement bundle; it only refreshes a refresh token it stores for this
 * instance's account. The instance authenticates with its enrolled token, as
 * for the handoff redeem.
 *
 * Only Rome Cloud's explicit `invalid_grant` is a refusal, after which the grant
 * needs a reconnect. Every other failure throws `RenewalUnavailable`, so the
 * grant is kept and retried: Rome Cloud not answering (network, timeout, 429,
 * 5xx), or this instance failing to authenticate to it (not enrolled, a 401 or
 * 403), says nothing about the provider grant itself.
 */
export async function refreshRomeCloudOAuthGrant(
  provider: OAuthProvider,
  refreshToken: string,
): Promise<OAuthTokenBundle> {
  const romeCloudOrigin = getRomeCloudOrigin();
  if (!romeCloudOrigin) {
    throw new RenewalUnavailable("Rome Cloud origin is not configured for OAuth refresh.");
  }
  const instanceToken = getInstanceToken();
  if (!instanceToken) {
    throw new RenewalUnavailable("This instance is not enrolled with Rome Cloud.");
  }

  let response: Response;
  try {
    response = await fetch(new URL("/connections/token", romeCloudOrigin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Authorization: `Bearer ${instanceToken}`,
      },
      cache: "no-store",
      body: JSON.stringify({ grant_type: "refresh_token", provider, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RenewalUnavailable("Rome Cloud OAuth refresh did not complete.", error);
  }

  // fetch resolves at the headers, so the body can still time out or drop.
  // That is Rome Cloud not answering, not a refusal.
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new RenewalUnavailable("Rome Cloud OAuth refresh response did not complete.", error);
  }
  let data: {
    provider?: unknown;
    tokens?: OAuthTokenBundle;
    error?: string;
    error_description?: string;
  } | null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.error_description ||
      data?.error ||
      `Rome Cloud OAuth refresh failed with status ${response.status}.`;
    if (response.status === 400 && data?.error === "invalid_grant") {
      throw new Error(message);
    }
    throw new RenewalUnavailable(message);
  }
  // A 200 that isn't a complete refresh answer (an outage page, a truncated
  // body, a bundle missing its refresh token or expiry) is Rome Cloud not
  // answering properly, not a refusal of the grant. Accepting a partial bundle
  // would replace a renewable credential with one that can never renew.
  if (data?.provider !== provider || !isCompleteRefreshBundle(data.tokens)) {
    throw new RenewalUnavailable("Rome Cloud returned an invalid OAuth refresh payload.");
  }
  return data.tokens;
}

/** A refreshed grant must carry a new access token, a refresh token for the
 *  next renewal, and the access token's expiry. */
function isCompleteRefreshBundle(tokens: OAuthTokenBundle | undefined): tokens is OAuthTokenBundle {
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  return (
    !!tokens &&
    nonEmpty(tokens.accessToken) &&
    nonEmpty(tokens.refreshToken) &&
    nonEmpty(tokens.expiresAt) &&
    !Number.isNaN(Date.parse(tokens.expiresAt as string))
  );
}
