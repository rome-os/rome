import { randomBytes } from "crypto";
import { createServer } from "http";
import type { AddressInfo } from "net";
import {
  buildAuthorizeUrl,
  type CloudCredential,
  fetchWithoutRedirect,
  NativeAuthError,
  parseAuthorizationCallback,
  parseDeviceTokenResponse,
  responseJson,
} from "@rome-os/libs/native-auth";
import { createPkce } from "@rome-os/libs/pkce";

export const DESKTOP_CLIENT_ID = "rome-desktop";
const CALLBACK_PATH = "/oauth/callback";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export type ComputerPlatform = "macos" | "linux" | "windows";

export function computerPlatform(platform: NodeJS.Platform = process.platform): ComputerPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export interface SignInOptions {
  cloudOrigin: string;
  openBrowser(url: string): Promise<void>;
  deviceName: string;
  platform: ComputerPlatform;
  appVersion: string;
  osVersion: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Rome</title>
<body style="font:15px system-ui;margin:4rem auto;max-width:28rem;text-align:center">
<p>You can close this tab and return to Rome.</p></body>`;

/**
 * Waits for one OAuth redirect on a loopback port picked at runtime (RFC 8252
 * §7.3). Resolves with the full callback URL; other paths get a 404 so a
 * browser's favicon request cannot end the wait.
 */
async function listenForCallback(
  signal: AbortSignal,
): Promise<{ redirectUri: string; callback: Promise<string> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  const callback = new Promise<string>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      server.closeAllConnections();
      server.close();
    };
    const abort = () => {
      finish();
      reject(new NativeAuthError("cancelled", "Sign-in was cancelled"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(CALLBACK_PAGE, finish);
      resolve(url.toString());
    });
  });
  return { redirectUri, callback };
}

/**
 * Signs this computer in to Rome Cloud as the desktop app: PKCE in the system
 * browser, the code back on loopback, then the token exchange. The browser
 * already holds the user's Rome Cloud session, so most sign-ins are one click.
 */
export async function signInToRomeCloud(options: SignInOptions): Promise<CloudCredential> {
  // Ends the loopback listener however this returns, including a browser that
  // never opened.
  const done = new AbortController();
  const signal = AbortSignal.any([
    done.signal,
    AbortSignal.timeout(options.timeoutMs ?? SIGN_IN_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("base64url");
  const { redirectUri, callback } = await listenForCallback(signal);
  callback.catch(() => undefined);
  try {
    return await exchange(options, { redirectUri, callback, verifier, challenge, state, signal });
  } finally {
    done.abort();
  }
}

async function exchange(
  options: SignInOptions,
  flow: {
    redirectUri: string;
    callback: Promise<string>;
    verifier: string;
    challenge: string;
    state: string;
    signal: AbortSignal;
  },
): Promise<CloudCredential> {
  const { redirectUri, callback, verifier, challenge, state, signal } = flow;
  await options.openBrowser(
    buildAuthorizeUrl({
      cloudOrigin: options.cloudOrigin,
      clientId: DESKTOP_CLIENT_ID,
      redirectUri,
      state,
      codeChallenge: challenge,
      displayName: options.deviceName,
    }),
  );

  const { code } = parseAuthorizationCallback({
    callbackUrl: await callback,
    expectedRedirectUri: redirectUri,
    expectedState: state,
    expectedIssuer: options.cloudOrigin,
  });

  // Cancelling or timing out still applies once the browser has answered:
  // the exchange is aborted, and an answer that arrives anyway is refused.
  const cancelled = () => new NativeAuthError("cancelled", "Sign-in was cancelled");
  let response: Response;
  try {
    response = await fetchWithoutRedirect(
      options.fetchImpl,
      new URL("/oauth2/token", options.cloudOrigin).toString(),
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: DESKTOP_CLIENT_ID,
          redirect_uri: redirectUri,
          platform: options.platform,
          app_version: options.appVersion,
          os_version: options.osVersion,
        }).toString(),
      },
      options.cloudOrigin,
    );
  } catch (err) {
    throw signal.aborted ? cancelled() : err;
  }
  if (!response.ok) throw new NativeAuthError("session_rejected", "Rome Cloud rejected sign-in");
  const credential = parseDeviceTokenResponse(await responseJson(response));
  if (signal.aborted) throw cancelled();
  return credential;
}
