import { z } from "zod";
import { CredentialRejected, ProviderOperationError } from "../../errors.js";
import type { FeishuAppMaterial } from "./descriptor.js";

const MAX_RESPONSE_BYTES = 256 * 1024;

export interface Endpoint {
  method: "GET" | "POST" | "DELETE";
  url: string;
  params?: Record<string, string | number | undefined>;
  data?: Record<string, unknown>;
}
export type FeishuRequest = (
  material: FeishuAppMaterial,
  endpoint: Endpoint,
  signal: AbortSignal,
) => Promise<unknown>;
export type FeishuDocumentRequest = (
  material: FeishuAppMaterial,
  documentId: string,
  signal: AbortSignal,
) => Promise<unknown>;

export function createFeishuRequest(): FeishuRequest {
  let cache: import("@larksuiteoapi/node-sdk").DefaultCache | undefined;
  return async (material, endpoint, signal) => {
    const { Client, Domain, DefaultCache, defaultHttpInstance } = await import(
      "@larksuiteoapi/node-sdk"
    );
    // A grant epoch owns its cache. Concurrent reads need separate cancellation scopes.
    cache ??= new DefaultCache();
    const http = defaultHttpInstance.create();
    http.interceptors.request.use((config) => ({
      ...config,
      timeout: 15_000,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      signal,
    }));
    http.interceptors.response.use((response) => {
      // Classify token business failures before the SDK flattens their code into text.
      const code = z.object({ code: z.number() }).safeParse(response.data);
      if (
        response.config.url?.endsWith("/open-apis/auth/v3/tenant_access_token/internal") &&
        code.success &&
        code.data.code !== 0
      ) {
        throw responseError(response.data);
      }
      return response.data;
    });
    const quiet = () => {};
    const client = new Client({
      appId: material.appId,
      appSecret: material.appSecret,
      domain: material.domain === "lark" ? Domain.Lark : Domain.Feishu,
      cache,
      httpInstance: http,
      logger: { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet },
    });
    return client.request({
      ...endpoint,
      timeout: 15_000,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      signal,
    });
  };
}

export function responseError(
  value: unknown,
  documentRead = false,
): ProviderOperationError | CredentialRejected {
  const parsed = z.object({ code: z.number() }).safeParse(value);
  const code = parsed.success ? parsed.data.code : undefined;
  if (
    code === 10003 ||
    code === 10014 ||
    code === 99991663 ||
    code === 99991664 ||
    (!documentRead && code === 99991665) ||
    code === 99991668 ||
    code === 99991671
  ) {
    return new CredentialRejected({ grant: "app" });
  }
  if (!documentRead && code !== undefined) {
    if ([131006, 191002, 193002, 194001, 970003, 1254302, 1254304, 1310213].includes(code))
      return new ProviderOperationError("provider_resource_denied");
    if (
      [
        131005, 191000, 193001, 970005, 1254040, 1254041, 1254042, 1254043, 1254044, 1310214,
      ].includes(code)
    ) {
      return new ProviderOperationError("provider_not_found");
    }
  }
  if (code === 99991672 || code === 99991676 || code === 99991679) {
    return new ProviderOperationError("provider_scope_required");
  }
  if (code === 1770032) return new ProviderOperationError("provider_resource_denied");
  if (code === 1770033) return new ProviderOperationError("provider_response_too_large");
  if (code === 1770002 || code === 1770003) return new ProviderOperationError("provider_not_found");
  return new ProviderOperationError("provider_unavailable", true);
}

export function mapRequestError(error: unknown, documentRead: boolean): never {
  if (error instanceof CredentialRejected || error instanceof ProviderOperationError) throw error;
  // Axios errors can contain request headers. Expose only allowlisted reasons.
  const sizeFailure = z
    .object({
      code: z.literal("ERR_BAD_RESPONSE"),
      message: z.string().regex(/^maxContentLength size of \d+ exceeded$/),
    })
    .safeParse(error);
  if (sizeFailure.success) throw new ProviderOperationError("provider_response_too_large");
  const response = z
    .object({ response: z.object({ status: z.number(), data: z.unknown() }) })
    .safeParse(error);
  if (response.success) {
    const mapped = responseError(response.data.response.data, documentRead);
    if (mapped instanceof CredentialRejected || mapped.reason !== "provider_unavailable")
      throw mapped;
    if (documentRead && response.data.response.status === 401)
      throw new CredentialRejected({ grant: "app" });
    if (!documentRead) {
      if (response.data.response.status === 403)
        throw new ProviderOperationError("provider_resource_denied");
      if (response.data.response.status === 404)
        throw new ProviderOperationError("provider_not_found");
    }
  }
  throw new ProviderOperationError("provider_unavailable", true);
}
