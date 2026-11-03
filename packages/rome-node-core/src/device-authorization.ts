import { isRecord } from "./actions.js";
import { cloudOrigin } from "./cloud.js";
import { devicePlatform, deviceSessionFromToken, type DeviceSession } from "./device-session.js";

export interface DeviceAuthorizationPrompt {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  /** Authorization lifetime in seconds. */
  expiresIn: number;
}

class DeviceAuthorizationError extends Error {}
class RetryableRequestError extends Error {}

function seconds(value: unknown): value is number {
  // Node clamps overflowing timer delays to one millisecond.
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483;
}

function verificationUrl(value: unknown, origin: string): string {
  if (typeof value !== "string")
    throw new DeviceAuthorizationError("Invalid device authorization response.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeviceAuthorizationError("Invalid device authorization response.");
  }
  if (url.origin !== origin || url.username || url.password)
    throw new DeviceAuthorizationError("Invalid device authorization response.");
  return url.href;
}

async function post(origin: string, path: string, body: URLSearchParams, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      method: "POST",
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new RetryableRequestError();
  }
  // Proxies can return HTML or empty bodies for transient HTTP failures.
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    throw new RetryableRequestError();
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new DeviceAuthorizationError("Invalid device authorization response.");
    throw new RetryableRequestError();
  }
  return { response, result };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Polls until approval or expiry. Aborting cancels requests and timers. The callback receives no credentials. */
export async function loginDeviceCode(
  cloudUrl: string,
  name: string,
  signal: AbortSignal,
  onAuthorizationRequired: (prompt: DeviceAuthorizationPrompt) => void,
): Promise<DeviceSession> {
  const origin = cloudOrigin(cloudUrl);
  const expiry = new AbortController();
  const pollingSignal = AbortSignal.any([signal, expiry.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    const { response, result } = await post(
      origin,
      "/oauth2/device_authorization",
      new URLSearchParams({
        client_id: "rome-computer",
        display_name: name,
        platform: devicePlatform(),
      }),
      signal,
    );
    if (
      !response.ok ||
      !isRecord(result) ||
      typeof result.device_code !== "string" ||
      !result.device_code ||
      typeof result.user_code !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(result.user_code) ||
      !seconds(result.expires_in) ||
      !seconds(result.interval)
    )
      throw new DeviceAuthorizationError("Invalid device authorization response.");
    const prompt: DeviceAuthorizationPrompt = {
      verificationUri: verificationUrl(result.verification_uri, origin),
      verificationUriComplete: verificationUrl(result.verification_uri_complete, origin),
      userCode: result.user_code,
      expiresIn: result.expires_in,
    };
    const deadline = Date.now() + result.expires_in * 1000;
    timer = setTimeout(() => expiry.abort(), result.expires_in * 1000);
    onAuthorizationRequired(prompt);
    let interval = result.interval * 1000;
    while (true) {
      // Wait before every poll, including the first. Backoff persists after pending responses.
      await wait(Math.min(interval, Math.max(0, deadline - Date.now())), pollingSignal);
      if (Date.now() >= deadline) expiry.abort();
      pollingSignal.throwIfAborted();
      let polled: Awaited<ReturnType<typeof post>>;
      try {
        polled = await post(
          origin,
          "/oauth2/token",
          new URLSearchParams({
            client_id: "rome-computer",
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: result.device_code,
          }),
          pollingSignal,
        );
      } catch (error) {
        pollingSignal.throwIfAborted();
        if (!(error instanceof RetryableRequestError)) throw error;
        // Backoff must never reduce the interval required by Cloud's slow_down responses.
        interval = Math.max(interval, Math.min(interval * 2, 60_000));
        continue;
      }
      const { response, result: token } = polled;
      pollingSignal.throwIfAborted();
      if (response.ok) {
        const session = deviceSessionFromToken(token, origin);
        if (!session) throw new DeviceAuthorizationError("Invalid token response.");
        return session;
      }
      if (response.status === 400 && isRecord(token)) {
        if (token.error === "authorization_pending") continue;
        if (token.error === "slow_down") {
          interval += 5000;
          continue;
        }
        if (token.error === "access_denied")
          throw new DeviceAuthorizationError("Device authorization denied.");
        if (token.error === "expired_token")
          throw new DeviceAuthorizationError("Device authorization expired.");
        if (token.error === "invalid_grant")
          throw new DeviceAuthorizationError("Device authorization is invalid.");
      }
      throw new DeviceAuthorizationError("Device authorization rejected.");
    }
  } catch (error) {
    if (signal.aborted) throw new DeviceAuthorizationError("Authorization canceled.");
    if (expiry.signal.aborted) throw new DeviceAuthorizationError("Device authorization expired.");
    // Do not expose response bodies or fetch errors, which can contain credentials.
    if (error instanceof DeviceAuthorizationError) throw error;
    throw new DeviceAuthorizationError(
      "Could not complete device authorization. Try connecting again.",
    );
  } finally {
    clearTimeout(timer);
  }
}
