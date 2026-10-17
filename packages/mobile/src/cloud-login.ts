import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as WebBrowser from "expo-web-browser";
import {
  buildAuthorizeUrl,
  type CloudCredential,
  fetchWithoutRedirect,
  NativeAuthError,
  parseAuthorizationCallback,
  parseDeviceTokenResponse,
  responseJson,
  toBase64Url,
} from "@rome-os/libs/native-auth";
import { validateOAuthConfiguration } from "./oauth-protocol";

function randomBase64Url(length: number): string {
  const bytes = Crypto.getRandomBytes(length);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return toBase64Url(globalThis.btoa(binary));
}

export async function signInToRomeCloud(input: {
  cloudOrigin: string;
  clientId: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudCredential> {
  validateOAuthConfiguration(input.cloudOrigin, input.redirectUri);
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(16);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const authorizeUrl = buildAuthorizeUrl({
    cloudOrigin: input.cloudOrigin,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    state,
    codeChallenge: toBase64Url(digest),
    displayName: Device.deviceName ?? Device.modelName ?? "Rome Mobile",
  });

  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, input.redirectUri, {
    preferEphemeralSession: true,
    preferUniversalLinks: false,
  });
  if (result.type !== "success") {
    throw new NativeAuthError("cancelled", "Sign-in was cancelled");
  }
  const { code } = parseAuthorizationCallback({
    callbackUrl: result.url,
    expectedRedirectUri: input.redirectUri,
    expectedState: state,
    expectedIssuer: input.cloudOrigin,
  });

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
  });
  if (Device.modelName) form.set("device_model", Device.modelName);
  if (Device.osVersion) form.set("os_version", Device.osVersion);
  if (Application.nativeApplicationVersion) {
    form.set("app_version", Application.nativeApplicationVersion);
  }
  const response = await fetchWithoutRedirect(
    input.fetchImpl ?? fetch,
    new URL("/oauth2/token", input.cloudOrigin).toString(),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    input.cloudOrigin,
  );
  if (!response.ok) throw new NativeAuthError("session_rejected", "Rome Cloud rejected sign-in");
  return parseDeviceTokenResponse(await responseJson(response));
}
