import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createGmailActor, gmailRawMessage, gmailSendSchema } from "./api.js";

const message = {
  connectionId: "google-1",
  from: "guardian@example.com",
  to: ["recipient@example.com"],
  subject: "Re: Hello 世界",
  body: "Exact body\nBcc: not-a-header@example.com",
  inReplyTo: "<original@example.com>",
};
const actor = () =>
  createGmailActor({ material: { accessToken: "test-token" }, expiresAt: "never" });
afterEach(() => {
  rs.unstubAllGlobals();
});

describe("Gmail API boundary", () => {
  it("allows only enumerated reads and safely encodes query values", async () => {
    const fetch = rs.fn().mockResolvedValue(Response.json({ messages: [] }));
    rs.stubGlobal("fetch", fetch);
    await actor().invoke({
      operation: "read",
      input: {
        path: "/gmail/v1/users/me/messages",
        query: { q: "from:a@example.com&access_token=evil" },
      },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url.searchParams.get("q")).toBe("from:a@example.com&access_token=evil");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("rejects mutations, path tricks, uploads, settings, arbitrary headers and credential query parameters before fetch", async () => {
    const fetch = rs.fn();
    rs.stubGlobal("fetch", fetch);
    for (const path of [
      "/gmail/v1/users/me/messages/a/trash",
      "/gmail/v1/users/me/messages/send",
      "/gmail/v1/users/me/messages/../profile",
      "/upload/gmail/v1/users/me/messages/send",
      "/gmail/v1/users/me/settings",
      "/gmail/v1/users/me/messages%2fsend",
      "/gmail/v1/users/me/profile?alt=media",
      "//evil.com",
    ]) {
      await expect(actor().invoke({ operation: "read", input: { path } })).rejects.toThrow();
    }
    for (const extra of [
      { method: "POST" },
      { body: {} },
      { headers: { "X-HTTP-Method-Override": "DELETE" } },
      { host: "storage.googleapis.com" },
      { query: { access_token: "evil" } },
    ]) {
      await expect(
        actor().invoke({
          operation: "read",
          input: { path: "/gmail/v1/users/me/profile", ...extra },
        }),
      ).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(
      actor()
        .operations()
        .map((operation) => operation.name),
    ).toEqual(["read", "send"]);
    expect(
      actor()
        .operations()
        .every((operation) => operation.appAccess === undefined),
    ).toBe(true);
  });

  it("sends only generated MIME to the one send endpoint, with the approved sender", async () => {
    const fetch = rs
      .fn()
      .mockResolvedValueOnce(Response.json({ emailAddress: message.from }))
      .mockResolvedValueOnce(Response.json({ id: "sent-1" }));
    rs.stubGlobal("fetch", fetch);
    await actor().invoke({ operation: "send", input: message });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1];
    expect(url.href).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ raw: gmailRawMessage(message) });
    const raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString("utf8");
    const [headers, body] = raw.split("\r\n\r\n");
    expect(headers).toContain(`From: ${message.from}`);
    expect(headers).toContain(`To: ${message.to[0]}`);
    expect(headers).not.toContain("Bcc:");
    expect(Buffer.from(body, "base64").toString()).toBe(message.body);
    expect(
      [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
        .map((part) => Buffer.from(part[1], "base64").toString())
        .join(""),
    ).toBe(message.subject);
  });

  it("keeps an approved send in its Gmail thread and lets an already-dispatched POST finish across renewal", async () => {
    const connected = actor();
    const fetch = rs
      .fn()
      .mockResolvedValueOnce(Response.json({ emailAddress: message.from }))
      .mockImplementationOnce(async (_url: unknown, init?: RequestInit) => {
        connected.stop!();
        expect(init!.signal!.aborted).toBe(false);
        expect(JSON.parse(init!.body as string).threadId).toBe("thread_1");
        return Response.json({ id: "sent-1" });
      });
    rs.stubGlobal("fetch", fetch);
    await expect(
      connected.invoke({ operation: "send", input: { ...message, threadId: "thread_1" } }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("rejects a changed sender, unknown operations, and MIME/header injection", async () => {
    const fetch = rs.fn().mockResolvedValue(Response.json({ emailAddress: "other@example.com" }));
    rs.stubGlobal("fetch", fetch);
    await expect(actor().invoke({ operation: "send", input: message })).rejects.toThrow(/From/);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(actor().invoke({ operation: "delete", input: {} })).rejects.toThrow();
    for (const extra of [
      { from: "a@example.com\r\nBcc: hidden@example.com" },
      { subject: "ok\r\nBcc: hidden@example.com" },
      { inReplyTo: "<x>\r\nBcc: hidden" },
      { raw: "unapproved MIME" },
      { bcc: "hidden@example.com" },
    ]) {
      expect(gmailSendSchema.safeParse({ ...message, ...extra }).success).toBe(false);
    }
  });

  it("does not follow redirects and signals rejected credentials without retrying a send", async () => {
    const fetch = rs.fn().mockResolvedValue(Response.json({}, { status: 401 }));
    rs.stubGlobal("fetch", fetch);
    await expect(
      actor().invoke({ operation: "read", input: { path: "/gmail/v1/users/me/profile" } }),
    ).rejects.toMatchObject({ name: "CredentialRejected" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops an old credential epoch from sending after a refresh or disconnect", async () => {
    const fetch = rs.fn();
    rs.stubGlobal("fetch", fetch);
    const old = actor();
    old.stop!();
    await expect(old.invoke({ operation: "send", input: message })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
