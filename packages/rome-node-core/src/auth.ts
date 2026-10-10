import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./actions.js";
import { CloudError, cloudOrigin, gatewayConfig } from "./cloud.js";
import { daemonStatus } from "./daemon-client.js";
import {
  callerCredentialPath,
  readOptionalCallerCredential,
  CallerConfigurationError,
  type NodeConfig,
} from "./local.js";
import { writePrivateJson } from "./storage.js";

const communicationToken = /^romedev_[A-Za-z0-9_-]{43}$/;

class ServerAuthError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export async function configureCaller(
  origin: string,
  token: string,
  config: NodeConfig,
): Promise<void> {
  if (!communicationToken.test(token)) throw new Error("Invalid communication token.");
  if (await daemonStatus(config))
    throw new CallerConfigurationError(
      "daemon_running",
      "Stop the caller daemon before changing credentials.",
    );
  await gatewayConfig(origin, token);
  await writePrivateJson(callerCredentialPath(config), { cloudUrl: origin, token });
}

async function exchangeInstanceToken(origin: string, token: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/instance/gateway-credential", origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ServerAuthError("Could not reach Rome Cloud to authorize this server.", true);
  }
  if (!response.ok)
    throw new ServerAuthError(
      `Rome Cloud rejected server authorization (HTTP ${response.status}).`,
      response.status === 429 || response.status >= 500,
    );
  const body: unknown = await response.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.deviceToken !== "string" ||
    !communicationToken.test(body.deviceToken)
  )
    throw new ServerAuthError("Rome Cloud returned an invalid communication credential.");
  return body.deviceToken;
}

export async function authorizeServer(
  origin: string,
  instanceToken: string | undefined,
  config: NodeConfig,
  onRetry?: () => void,
): Promise<void> {
  const cloudUrl = cloudOrigin(origin);
  const existing = await readOptionalCallerCredential(config);
  if (existing) {
    if (existing.cloudUrl !== cloudUrl)
      throw new Error(
        "Caller credentials belong to another Cloud origin. Configure auth manually.",
      );
    return;
  }
  const token = instanceToken?.trim();
  if (!token || !/^romeinst_[A-Za-z0-9_-]+$/.test(token))
    throw new CallerConfigurationError(
      "instance_token_required",
      "Server authorization requires an Instance Token.",
    );
  if (await daemonStatus(config))
    throw new CallerConfigurationError(
      "daemon_running",
      "Stop the caller daemon before configuring credentials.",
    );

  let deviceToken: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await delay(attempt === 1 ? 1000 : 5000);
    try {
      // Reuse a minted token when validation fails transiently. Another POST
      // would leave an additional permanent credential at Cloud.
      deviceToken ??= await exchangeInstanceToken(cloudUrl, token);
      await configureCaller(cloudUrl, deviceToken, config);
      return;
    } catch (error) {
      const retryable =
        (error instanceof ServerAuthError && error.retryable) ||
        (error instanceof CloudError && error.code === "cloud_unavailable");
      if (!retryable || attempt === 2) throw error;
      onRetry?.();
    }
  }
}
