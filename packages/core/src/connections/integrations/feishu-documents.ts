// App access contract: docs/concepts/apps.md#connection-access.
import { z } from "zod";
import { CredentialRejected, ProviderOperationError } from "../errors.js";
import type { Actor, OperationDescriptor, ProfileRecord } from "../types.js";
import type { FeishuAppMaterial } from "./feishu.js";

export const FEISHU_DOCUMENT_READ = "feishu.document.read";
export const FEISHU_DOCUMENT_SCOPE = "docx:document:readonly";
const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const inputSchema = z.object({ documentId: z.string().regex(/^[a-zA-Z0-9]{1,128}$/) }).strict();

export const FEISHU_DOCUMENT_OPERATIONS: readonly OperationDescriptor[] = [
  {
    name: FEISHU_DOCUMENT_READ,
    description:
      "Read the plain text of one Docx document as the connected bot. Requires docx:document:readonly and access to that document.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["documentId"],
      properties: { documentId: { type: "string", pattern: "^[a-zA-Z0-9]{1,128}$" } },
    },
    appAccess: { sideEffects: "read-only" },
  },
];

export type FeishuDocumentRequest = (
  material: FeishuAppMaterial,
  documentId: string,
  signal: AbortSignal,
) => Promise<unknown>;

function createDocumentRequest(): FeishuDocumentRequest {
  let cache: import("@larksuiteoapi/node-sdk").DefaultCache | undefined;
  return async (material, documentId, signal) => {
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
    http.interceptors.response.use((response) => response.data);
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
      method: "GET",
      url: `/open-apis/docx/v1/documents/${documentId}/raw_content`,
      timeout: 15_000,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      signal,
    });
  };
}

/** Only public profile fields may become provider-console links. */
export function feishuDocumentGuidance(profile?: ProfileRecord) {
  const appId =
    typeof profile?.appId === "string" && /^cli_[a-zA-Z0-9]+$/.test(profile.appId)
      ? profile.appId
      : null;
  const brands: Array<"feishu" | "lark"> =
    profile?.domain === "feishu" || profile?.domain === "lark"
      ? [profile.domain]
      : ["feishu", "lark"];
  return {
    scope: FEISHU_DOCUMENT_SCOPE,
    scopeStatus: "not_checked" as const,
    consoles: brands.map((brand) => ({
      brand,
      url: `${brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"}/app${appId ? `/${encodeURIComponent(appId)}/auth` : ""}`,
    })),
  };
}

function responseError(value: unknown): ProviderOperationError | CredentialRejected {
  const parsed = z.object({ code: z.number() }).safeParse(value);
  const code = parsed.success ? parsed.data.code : undefined;
  if (code === 99991663 || code === 99991664 || code === 99991668 || code === 99991671) {
    return new CredentialRejected({ grant: "app" });
  }
  // Document permission failures must not degrade the grant shared with IM.
  // The Talker classifies transport faults, not document authorization responses.
  if (code === 99991672 || code === 99991676 || code === 99991679) {
    return new ProviderOperationError("provider_scope_required");
  }
  if (code === 1770032) return new ProviderOperationError("provider_resource_denied");
  if (code === 1770033) return new ProviderOperationError("provider_response_too_large");
  if (code === 1770002 || code === 1770003) return new ProviderOperationError("provider_not_found");
  return new ProviderOperationError("provider_unavailable", true);
}

/** Uses only the connected app identity; no user OAuth, URL input, or CLI fallback. */
export function createFeishuDocumentActor(
  material: FeishuAppMaterial,
  request: FeishuDocumentRequest = createDocumentRequest(),
): Actor {
  const stopped = new AbortController();
  return {
    operations: () => FEISHU_DOCUMENT_OPERATIONS,
    stop: () => stopped.abort(),
    async invoke(call) {
      if (call.operation !== FEISHU_DOCUMENT_READ) throw new Error("operation_not_found");
      const input = inputSchema.parse(call.input);
      const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(15_000)]);
      signal.throwIfAborted();
      let raw: unknown;
      try {
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new ProviderOperationError("provider_unavailable", true));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          raw = await Promise.race([request(material, input.documentId, signal), aborted]);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      } catch (error) {
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
          if (response.data.response.status === 401) throw new CredentialRejected({ grant: "app" });
          const mapped = responseError(response.data.response.data);
          if (mapped instanceof CredentialRejected || mapped.reason !== "provider_unavailable")
            throw mapped;
        }
        throw new ProviderOperationError("provider_unavailable", true);
      }
      signal.throwIfAborted();
      const envelope = z
        .object({ code: z.number(), data: z.object({ content: z.string() }).optional() })
        .safeParse(raw);
      if (!envelope.success) throw new ProviderOperationError("provider_response_invalid");
      if (envelope.data.code !== 0) throw responseError(envelope.data);
      if (!envelope.data.data) throw new ProviderOperationError("provider_response_invalid");
      const content = envelope.data.data.content;
      if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
        throw new ProviderOperationError("provider_response_too_large");
      }
      return { documentId: input.documentId, content, format: "plain_text", complete: true };
    },
  };
}
