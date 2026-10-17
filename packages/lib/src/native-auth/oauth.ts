import type { CloudCredential } from "./types.js";
import { NativeAuthError } from "./types.js";
import { parseCloudCredential } from "./validation.js";

export function toBase64Url(value: string): string {
  return value.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function buildAuthorizeUrl(input: {
  cloudOrigin: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  displayName: string;
}): string {
  const url = new URL("/oauth2/authorize", input.cloudOrigin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("display_name", input.displayName);
  return url.toString();
}

export function parseAuthorizationCallback(input: {
  callbackUrl: string;
  expectedRedirectUri: string;
  expectedState: string;
  expectedIssuer: string;
}): { code: string } {
  const callback = new URL(input.callbackUrl);
  const expected = new URL(input.expectedRedirectUri);
  if (
    callback.protocol !== expected.protocol ||
    callback.username !== expected.username ||
    callback.password !== expected.password ||
    callback.host !== expected.host ||
    callback.pathname !== expected.pathname ||
    callback.hash
  ) {
    throw new NativeAuthError("invalid_response", "The sign-in callback did not match this app");
  }
  if (callback.searchParams.get("state") !== input.expectedState) {
    throw new NativeAuthError("invalid_response", "The sign-in state did not match");
  }
  if (callback.searchParams.get("iss") !== input.expectedIssuer) {
    throw new NativeAuthError("invalid_response", "The sign-in issuer did not match Rome Cloud");
  }
  const oauthError = callback.searchParams.get("error");
  if (oauthError) throw new NativeAuthError("session_rejected", "Rome Cloud denied sign-in");
  const code = callback.searchParams.get("code");
  if (!code) throw new NativeAuthError("invalid_response", "The sign-in callback had no code");
  return { code };
}

export function parseDeviceTokenResponse(value: unknown): CloudCredential {
  const credential = parseCloudCredential(value);
  if (!credential)
    throw new NativeAuthError("invalid_response", "The device credential was invalid");
  return credential;
}
