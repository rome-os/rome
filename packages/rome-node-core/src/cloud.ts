import { isRecord } from "./actions.js";
import { containerNodeOrigin, CONTAINER_NODE_SOCKET_PATH } from "./container-node-address.js";
import { parseGatewayUrl } from "./gateway-url.js";

const messages: Record<string, string> = {
  invalid_device_session: "Device authorization is invalid.",
  device_not_found: "No device with this ID exists in the account.",
  invalid_device_name: "Use a name of 1 to 80 characters without control characters.",
  revocation_pending:
    "The device is revoked. Rome Cloud deletes it after the Gateway confirms the revocation. Remove it again later.",
};

/** Error codes that Cloud returns for device management requests. */
const deviceErrors = new Set(["device_not_found", "invalid_device_name", "revocation_pending"]);

export class CloudError extends Error {
  constructor(readonly code: string) {
    super(messages[code] ?? "Rome Cloud is unavailable. Retry later.");
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

/** A fixed token, or a provider that returns a fresh one for each Cloud call. */
export type TokenSource = string | (() => string | Promise<string>);

export async function cloudRequest(
  origin: string,
  path: string,
  token: TokenSource,
  method = "GET",
  json?: unknown,
): Promise<unknown> {
  return request(() => new URL(path, cloudOrigin(origin)), token, method, json);
}

async function request(url: () => URL, token: TokenSource, method = "GET", json?: unknown) {
  let response: Response;
  try {
    response = await fetch(url(), {
      method,
      headers: {
        Authorization: `Bearer ${typeof token === "string" ? token : await token()}`,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
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
    if (isRecord(body) && typeof body.error === "string" && deviceErrors.has(body.error))
      throw new CloudError(body.error);
    throw new CloudError("cloud_unavailable");
  }
  return body;
}

export async function gatewayConfig(
  origin: string,
  token: TokenSource,
  directHttp = false,
): Promise<string> {
  const body = directHttp
    ? await request(() => new URL("/v1/gateway/config", containerNodeOrigin(origin)), token)
    : await cloudRequest(origin, "/v1/gateway/config", token);
  if (!isRecord(body)) throw new CloudError("invalid_response");
  try {
    const base = new URL(origin);
    if (directHttp) {
      if (body.gatewayPath === CONTAINER_NODE_SOCKET_PATH)
        return parseGatewayUrl(`ws://${base.host}${CONTAINER_NODE_SOCKET_PATH}`, base.origin).href;
      throw new CloudError("invalid_response");
    }
    if (typeof body.gatewayUrl === "string") return parseGatewayUrl(body.gatewayUrl).href;
    if (typeof body.gatewayPath === "string" && /^\/(?![/\\])/.test(body.gatewayPath)) {
      const url = new URL(body.gatewayPath, base);
      if (url.origin === base.origin) {
        url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
        return parseGatewayUrl(url.href).href;
      }
    }
  } catch {
    throw new CloudError("invalid_response");
  }
  throw new CloudError("invalid_response");
}
