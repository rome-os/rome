import { createHmac } from "node:crypto";
import { describe, expect, it } from "@rstest/core";
import {
  normalizeGithubPayload,
  resolveInstanceWebhookUrl,
  verifyGithubSignature,
} from "./github-webhook.js";
import { resolveRelayDepositUrl } from "./relay-webhook.js";

const WEBHOOK_PATH = "/api/app-api/connector/webhook";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  const secret = "s3cr3t-shared-hmac";
  const body = '{"action":"opened","number":7}';

  it("accepts a delivery signed with the shared secret", async () => {
    expect(await verifyGithubSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = sign(body, secret);
    expect(await verifyGithubSignature(`${body} `, sig, secret)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", async () => {
    expect(await verifyGithubSignature(body, sign(body, "other-secret"), secret)).toBe(false);
  });

  it("rejects a missing or malformed signature header", async () => {
    expect(await verifyGithubSignature(body, undefined, secret)).toBe(false);
    expect(await verifyGithubSignature(body, "", secret)).toBe(false);
    // Wrong algorithm prefix (GitHub's legacy sha1 header), not what we verify.
    expect(await verifyGithubSignature(body, `sha1=${"a".repeat(40)}`, secret)).toBe(false);
    expect(await verifyGithubSignature(body, "sha256=deadbeef", secret)).toBe(false);
  });
});

describe("normalizeGithubPayload", () => {
  const iso = "2026-06-26T00:00:00.000Z";

  it("fixes provider to github and lowercases the event type from the header", () => {
    expect(normalizeGithubPayload({ action: "opened" }, "Pull_Request", "guid-1", iso)).toEqual({
      eventId: "guid-1",
      provider: "github",
      eventType: "pull_request",
      receivedAt: iso,
      data: { action: "opened" },
    });
  });

  it("coerces a non-object body to an empty data map", () => {
    expect(normalizeGithubPayload("not-json", "push", "g", iso).data).toEqual({});
    expect(normalizeGithubPayload([1, 2], "push", "g", iso).data).toEqual({});
    expect(normalizeGithubPayload(null, "push", "g", iso).data).toEqual({});
  });
});

describe("resolveInstanceWebhookUrl", () => {
  it("uses PANTHEON_INSTANCE_ORIGIN when set", () => {
    expect(resolveInstanceWebhookUrl({ PANTHEON_INSTANCE_ORIGIN: "https://acme.romeos.cc" })).toBe(
      `https://acme.romeos.cc${WEBHOOK_PATH}`,
    );
  });

  it("derives from slug + domain, trimming stray dots", () => {
    expect(resolveInstanceWebhookUrl({ PANTHEON_SLUG: "acme", PANTHEON_DOMAIN: "romeos.cc" })).toBe(
      `https://acme.romeos.cc${WEBHOOK_PATH}`,
    );
    expect(
      resolveInstanceWebhookUrl({ PANTHEON_SLUG: "acme", PANTHEON_DOMAIN: ".romeos.cc." }),
    ).toBe(`https://acme.romeos.cc${WEBHOOK_PATH}`);
  });

  it("returns null when the instance has no public domain", () => {
    expect(resolveInstanceWebhookUrl({})).toBeNull();
    expect(resolveInstanceWebhookUrl({ PANTHEON_SLUG: "acme" })).toBeNull();
    expect(resolveInstanceWebhookUrl({ PANTHEON_DOMAIN: "romeos.cc" })).toBeNull();
    expect(resolveInstanceWebhookUrl({ PANTHEON_INSTANCE_ORIGIN: "not a url" })).toBeNull();
  });
});

describe("resolveRelayDepositUrl", () => {
  it("returns the relay depositUrl from runtime settings", async () => {
    const settings = {
      get: async () => ({ depositUrl: "https://relay.example/h/mbox" }),
    };
    await expect(resolveRelayDepositUrl(settings)).resolves.toBe("https://relay.example/h/mbox");
  });

  it("returns null for missing or malformed relay settings", async () => {
    await expect(resolveRelayDepositUrl({ get: async () => null })).resolves.toBeNull();
    await expect(resolveRelayDepositUrl({ get: async () => ({}) })).resolves.toBeNull();
    await expect(
      resolveRelayDepositUrl({ get: async () => ({ depositUrl: "" }) }),
    ).resolves.toBeNull();
    await expect(
      resolveRelayDepositUrl({ get: async () => ({ depositUrl: 42 }) }),
    ).resolves.toBeNull();
  });
});
