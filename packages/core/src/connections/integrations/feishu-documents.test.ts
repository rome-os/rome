import { describe, expect, it, rs } from "@rstest/core";
import {
  createFeishuDocumentActor,
  FEISHU_DOCUMENT_OPERATIONS,
  FEISHU_DOCUMENT_READ,
  feishuDocumentGuidance,
} from "./feishu-documents.js";
import { CredentialRejected, ProviderOperationError } from "../errors.js";
rs.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
  DefaultCache: class {},
  defaultHttpInstance: {
    create: () => ({ interceptors: { request: { use: () => {} }, response: { use: () => {} } } }),
  },
  Client: class {
    constructor(private options: Record<string, unknown>) {}
    async request(input: Record<string, unknown>) {
      return {
        code: 0,
        data: {
          content: JSON.stringify({
            domain: this.options.domain,
            method: input.method,
            url: input.url,
            timeout: input.timeout,
            maxContentLength: input.maxContentLength,
            maxRedirects: input.maxRedirects,
          }),
        },
      };
    }
  },
}));
const material = { appId: "cli_fixture", appSecret: "synthetic-only", domain: "feishu" as const };
const call = { operation: FEISHU_DOCUMENT_READ, input: { documentId: "DocumentA" } };
describe("Feishu document guidance", () => {
  it("uses only valid public profile fields and never guesses an unknown provider region", () => {
    expect(
      feishuDocumentGuidance({ appId: "https://untrusted.example", domain: "unknown" }).consoles,
    ).toEqual([
      { brand: "feishu", url: "https://open.feishu.cn/app" },
      { brand: "lark", url: "https://open.larksuite.com/app" },
    ]);
    expect(
      feishuDocumentGuidance({
        appId: "cli_fixture",
        domain: "feishu",
        secret: "SYNTHETIC_NOT_FOR_UI",
      }),
    ).toEqual({
      scope: "docx:document:readonly",
      scopeStatus: "not_checked",
      consoles: [{ brand: "feishu", url: "https://open.feishu.cn/app/cli_fixture/auth" }],
    });
  });
});

describe("Feishu document reads", () => {
  it("exposes one read-only operation, with no arbitrary transport or write", () => {
    expect(FEISHU_DOCUMENT_OPERATIONS).toHaveLength(1);
    expect(FEISHU_DOCUMENT_OPERATIONS[0].appAccess).toEqual({ sideEffects: "read-only" });
  });
  it("uses the selected bot and returns only bounded plain text", async () => {
    let seen: unknown;
    const actor = createFeishuDocumentActor(material, async (credential, id) => {
      seen = { appId: credential.appId, id };
      return {
        code: 0,
        data: { content: "synthetic document", extra: "not returned" },
        extra: "not returned",
      };
    });
    expect(await actor.invoke(call)).toEqual({
      documentId: "DocumentA",
      content: "synthetic document",
      format: "plain_text",
      complete: true,
    });
    expect(seen).toEqual({ appId: "cli_fixture", id: "DocumentA" });
  });
  it("rejects URLs, traversal, extra inputs and other operations before the network", async () => {
    let calls = 0;
    const actor = createFeishuDocumentActor(material, async () => {
      calls++;
      return {};
    });
    for (const input of [
      { documentId: "../D" },
      { documentId: "https://evil.test/D" },
      { documentId: "D", path: "/anything" },
    ])
      await expect(actor.invoke({ ...call, input })).rejects.toThrow();
    await expect(actor.invoke({ ...call, operation: "raw.http" })).rejects.toThrow(
      "operation_not_found",
    );
    expect(calls).toBe(0);
  });
  it("distinguishes scope, resource, missing document and authentication failures without provider messages", async () => {
    for (const [code, reason] of [
      [99991672, "provider_scope_required"],
      [99991676, "provider_scope_required"],
      [1770032, "provider_resource_denied"],
      [1770002, "provider_not_found"],
    ] as const) {
      const actor = createFeishuDocumentActor(material, async () => ({
        code,
        msg: "SYNTHETIC_PRIVATE_PROVIDER_MESSAGE",
      }));
      await expect(actor.invoke(call)).rejects.toThrow(reason);
    }
    const refused = createFeishuDocumentActor(material, async () => ({ code: 99991663 }));
    await expect(refused.invoke(call)).rejects.toBeInstanceOf(CredentialRejected);
  });
  it("maps the Axios response ceiling to a permanent size failure, not a retryable outage", async () => {
    const actor = createFeishuDocumentActor(material, async () => {
      throw Object.assign(new Error("maxContentLength size of 262144 exceeded"), {
        code: "ERR_BAD_RESPONSE",
      });
    });
    await expect(actor.invoke(call)).rejects.toEqual(
      new ProviderOperationError("provider_response_too_large"),
    );
    const unrelated = createFeishuDocumentActor(material, async () => {
      throw Object.assign(new Error("unrelated failure"), { code: "ERR_BAD_RESPONSE" });
    });
    await expect(unrelated.invoke(call)).rejects.toEqual(
      new ProviderOperationError("provider_unavailable", true),
    );
  });
  it("does not degrade the bot for missing document permission, but rejects invalid app tokens", async () => {
    await expect(
      createFeishuDocumentActor(material, async () => ({ code: 99991679 })).invoke(call),
    ).rejects.toEqual(new ProviderOperationError("provider_scope_required"));
    await expect(
      createFeishuDocumentActor(material, async () => ({ code: 99991664 })).invoke(call),
    ).rejects.toBeInstanceOf(CredentialRejected);
  });
  it("rejects oversized, partial and malformed responses, never claiming a truncated result is complete", async () => {
    for (const value of [
      { code: 0 },
      { data: { content: "x" } },
      { code: 0, data: { content: 42 } },
    ]) {
      await expect(
        createFeishuDocumentActor(material, async () => value).invoke(call),
      ).rejects.toThrow("provider_response_invalid");
    }
    await expect(
      createFeishuDocumentActor(material, async () => ({
        code: 0,
        data: { content: "界".repeat(50000) },
      })).invoke(call),
    ).rejects.toThrow("provider_response_too_large");
  });
  it("discards thrown request details and stops in-flight reads on revocation", async () => {
    const unsafe = createFeishuDocumentActor(material, async () => {
      throw { config: { headers: { Authorization: "SYNTHETIC_AUTH" } } };
    });
    await expect(unsafe.invoke(call)).rejects.toEqual(
      new ProviderOperationError("provider_unavailable", true),
    );
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const actor = createFeishuDocumentActor(material, async (_credential, _id, signal) => {
      started();
      return await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    });
    const pending = actor.invoke(call);
    await ready;
    actor.stop?.();
    await expect(pending).rejects.toThrow();
    await expect(actor.invoke(call)).rejects.toThrow();
  });
  it("uses only the fixed official GET path with bounded transport on both provider domains", async () => {
    for (const domain of ["feishu", "lark"] as const) {
      const actor = createFeishuDocumentActor({ ...material, domain });
      const result = (await actor.invoke(call)) as { content: string };
      expect(JSON.parse(result.content)).toEqual({
        domain: domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
        method: "GET",
        url: "/open-apis/docx/v1/documents/DocumentA/raw_content",
        timeout: 15000,
        maxContentLength: 262144,
        maxRedirects: 0,
      });
    }
  });
});
