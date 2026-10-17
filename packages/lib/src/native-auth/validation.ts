import type {
  CloudCredential,
  CloudInstance,
  CloudInstanceAuthorization,
  InstanceAuthorizationRequest,
  InstanceSession,
} from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function exactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function parseCloudCredential(value: unknown): CloudCredential | null {
  const input = record(value);
  const accessToken = nonEmptyString(input?.access_token);
  const deviceSessionId = nonEmptyString(input?.device_session_id);
  if (!accessToken || input?.token_type !== "Bearer" || !deviceSessionId) return null;
  return { accessToken, deviceSessionId };
}

export function parseCloudInstance(value: unknown): CloudInstance | null {
  const input = record(value);
  const id = nonEmptyString(input?.id);
  const name = nonEmptyString(input?.name);
  const slug = nonEmptyString(input?.slug);
  const origin = exactHttpsOrigin(input?.origin);
  const status = nonEmptyString(input?.status);
  if (!id || !name || !slug || !origin || !status) return null;
  return { id, name, slug, origin, status };
}

export function parseInstanceAuthorizationRequest(
  value: unknown,
): InstanceAuthorizationRequest | null {
  const input = record(value);
  if (
    input?.response_type !== "code" ||
    input.client_id !== "rome-instance" ||
    input.scope !== "openid" ||
    input.code_challenge_method !== "S256"
  ) {
    return null;
  }
  const redirectUri = nonEmptyString(input.redirect_uri);
  const state = nonEmptyString(input.state);
  const challenge = nonEmptyString(input.code_challenge);
  const nonce = nonEmptyString(input.nonce);
  if (!redirectUri || !state || !challenge || !nonce) return null;
  return {
    response_type: "code",
    client_id: "rome-instance",
    redirect_uri: redirectUri,
    scope: "openid",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
  };
}

export function parseCloudInstanceAuthorization(value: unknown): CloudInstanceAuthorization | null {
  const input = record(value);
  const code = nonEmptyString(input?.code);
  const state = nonEmptyString(input?.state);
  const iss = exactHttpsOrigin(input?.iss);
  const expiresIn = input?.expires_in;
  if (!code || !state || !iss || typeof expiresIn !== "number" || expiresIn <= 0) return null;
  return { code, state, iss, expires_in: expiresIn };
}

export function parseInstanceSession(value: unknown): InstanceSession | null {
  const input = record(value);
  const token = nonEmptyString(input?.session_token);
  const expiresAt = nonEmptyString(input?.expires_at);
  const origin = exactHttpsOrigin(input?.origin);
  if (input?.cookie_name !== "rome_session" || !token || !expiresAt || !origin) return null;
  if (!Number.isFinite(Date.parse(expiresAt))) return null;
  return { cookieName: "rome_session", token, expiresAt, origin };
}
