/**
 * Native app sign-in to Rome Cloud and to the user's hosted Rome, shared by
 * Rome Mobile and the desktop app so both apps validate the same responses
 * the same way.
 *
 * The flow: an OAuth code with PKCE gets a Cloud credential, the credential
 * lists the hosted instances, and the instance, Cloud, and app then trade a
 * one-time code for a `rome_session` the app installs in its web view.
 *
 * Runtime-neutral: global `fetch` and `URL` only, so it runs under Hermes and
 * in Electron's main process. Each host injects its own fetch, secure storage,
 * and cookie store.
 */
export { CloudApi } from "./cloud-api.js";
export { CredentialVault, type SecureKeyValueStore } from "./credential-vault.js";
export { fetchWithoutRedirect, responseJson } from "./http.js";
export { InstanceSessionCoordinator, type SessionCookieStore } from "./instance-session.js";
export {
  buildAuthorizeUrl,
  parseAuthorizationCallback,
  parseDeviceTokenResponse,
  toBase64Url,
} from "./oauth.js";
export {
  type CloudCredential,
  type CloudInstance,
  type CloudInstanceAuthorization,
  type InstanceAuthorizationRequest,
  type InstanceSession,
  NativeAuthError,
  type NativeAuthErrorCode,
} from "./types.js";
export {
  exactHttpsOrigin,
  parseCloudCredential,
  parseCloudInstance,
  parseCloudInstanceAuthorization,
  parseInstanceAuthorizationRequest,
  parseInstanceSession,
} from "./validation.js";
