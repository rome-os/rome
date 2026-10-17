import { fetchWithoutRedirect, responseJson } from "./http.js";
import type {
  CloudCredential,
  CloudInstance,
  CloudInstanceAuthorization,
  InstanceAuthorizationRequest,
} from "./types.js";
import { NativeAuthError } from "./types.js";
import {
  exactHttpsOrigin,
  parseCloudInstance,
  parseCloudInstanceAuthorization,
} from "./validation.js";

export class CloudApi {
  readonly origin: string;

  constructor(
    origin: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const exactOrigin = exactHttpsOrigin(origin);
    if (!exactOrigin) throw new Error("Rome Cloud must be an exact HTTPS origin");
    this.origin = exactOrigin;
  }

  private async authenticatedRequest(
    path: string,
    credential: CloudCredential,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("Cloud request escaped its origin");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    headers.set("accept", "application/json");
    const response = await fetchWithoutRedirect(
      this.fetchImpl,
      url.toString(),
      { ...init, headers },
      this.origin,
    );
    if (response.status === 401) {
      throw new NativeAuthError("cloud_unauthorized", "The Rome Cloud session has expired");
    }
    return response;
  }

  async listInstances(credential: CloudCredential): Promise<CloudInstance[]> {
    const response = await this.authenticatedRequest("/v1/instances", credential);
    if (!response.ok) throw new NativeAuthError("network", "Rome Cloud could not list services");
    const body = await responseJson(response);
    const items =
      typeof body === "object" &&
      body !== null &&
      Array.isArray((body as { items?: unknown }).items)
        ? (body as { items: unknown[] }).items
        : null;
    if (!items) throw new NativeAuthError("invalid_response", "The service list was invalid");
    const parsed = items.map(parseCloudInstance);
    if (parsed.some((item) => item === null)) {
      throw new NativeAuthError("invalid_response", "The service list contained an invalid item");
    }
    const instances = parsed as CloudInstance[];
    if (instances.some((instance) => instance.origin === this.origin)) {
      throw new NativeAuthError("invalid_response", "A service reused the Rome Cloud origin");
    }
    return instances;
  }

  async createInstanceAuthorization(
    instance: CloudInstance,
    request: InstanceAuthorizationRequest,
    credential: CloudCredential,
  ): Promise<CloudInstanceAuthorization> {
    if (instance.status !== "running") {
      throw new NativeAuthError("instance_not_ready", "This service is not running");
    }
    const response = await this.authenticatedRequest(
      `/v1/instances/${encodeURIComponent(instance.id)}/authorizations`,
      credential,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authorization_request: request }),
      },
    );
    if (response.status === 409) {
      throw new NativeAuthError("instance_not_ready", "This service is not ready for sign-in");
    }
    if (response.status === 403) {
      throw new NativeAuthError("access_denied", "This service is no longer available");
    }
    if (!response.ok) {
      throw new NativeAuthError("session_rejected", "Rome Cloud rejected the service session");
    }
    const authorization = parseCloudInstanceAuthorization(await responseJson(response));
    if (!authorization) {
      throw new NativeAuthError("invalid_response", "The service authorization was invalid");
    }
    return authorization;
  }

  async revoke(credential: CloudCredential): Promise<boolean> {
    const response = await this.authenticatedRequest("/v1/mobile/session", credential, {
      method: "DELETE",
    });
    return response.status === 204;
  }
}
