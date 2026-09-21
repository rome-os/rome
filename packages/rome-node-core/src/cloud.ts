import { isRecord } from "./actions.js";

export class CloudError extends Error {
  constructor(readonly code: string) {
    super(
      code === "invalid_device_session"
        ? "Device authorization is invalid."
        : "Rome Cloud is unavailable. Retry later.",
    );
  }
}

export function cloudOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use an HTTPS Cloud origin. HTTP is allowed only on loopback.");
  return url.origin;
}

export async function cloudRequest(
  origin: string,
  path: string,
  token: string,
  method = "GET",
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, cloudOrigin(origin)), {
      method,
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    throw new CloudError("cloud_unavailable");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && isRecord(body) && body.error === "invalid_device_session")
      throw new CloudError("invalid_device_session");
    throw new CloudError("cloud_unavailable");
  }
  return body;
}

export async function gatewayConfig(origin: string, token: string): Promise<string> {
  const body = await cloudRequest(origin, "/v1/gateway/config", token);
  if (!isRecord(body) || typeof body.gatewayUrl !== "string")
    throw new CloudError("invalid_response");
  const url = new URL(body.gatewayUrl);
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash)
    throw new CloudError("invalid_response");
  return url.toString();
}
