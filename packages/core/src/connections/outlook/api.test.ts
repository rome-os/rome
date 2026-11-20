import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createOutlookActor, outlookSendMailBody, outlookSenderAddress } from "./api.js";

const message = {
  connectionId: "microsoft-1",
  from: "Guardian@Example.com",
  to: ["recipient@example.com"],
  subject: "Re: Hello 世界",
  body: "Exact body\nBcc: not-a-header@example.com",
};
const actor = () =>
  createOutlookActor({ material: { accessToken: "test-token" }, expiresAt: "never" });
afterEach(() => {
  rs.unstubAllGlobals();
});

describe("Outlook API boundary", () => {
  it("allows only enumerated Graph reads and safely encodes query values", async () => {
    const fetch = rs.fn().mockResolvedValue(Response.json({ value: [] }));
    rs.stubGlobal("fetch", fetch);
    await actor().invoke({
      operation: "read",
      input: {
        path: "/v1.0/me/mailFolders/inbox/messages",
        query: { $search: '"invoice"&access_token=evil', $top: 5 },
      },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url.origin).toBe("https://graph.microsoft.com");
    expect(url.searchParams.get("$search")).toBe('"invoice"&access_token=evil');
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { Authorization: "Bearer test-token", ConsistencyLevel: "eventual" },
    });
  });

  it("rejects mutations, attachments, MIME, other Graph APIs and arbitrary inputs before fetch", async () => {
    const fetch = rs.fn();
    rs.stubGlobal("fetch", fetch);
    for (const path of [
      "/v1.0/me/sendMail",
      "/v1.0/me/messages/abc/reply",
      "/v1.0/me/messages/abc/move",
      "/v1.0/me/messages/abc/attachments",
      "/v1.0/me/messages/abc/$value",
      "/v1.0/me/messages/../drive",
      "/v1.0/me/messages%2fsend",
      "/v1.0/me/drive/root/children",
      "/v1.0/users/someone@example.com/messages",
      "/beta/me/messages",
      "//evil.com",
    ]) {
      await expect(actor().invoke({ operation: "read", input: { path } })).rejects.toThrow();
    }
    for (const extra of [
      { method: "DELETE" },
      { body: {} },
      { headers: { "X-HTTP-Method-Override": "DELETE" } },
      { host: "evil.example.com" },
      { query: { $expand: "attachments" } },
      { query: { access_token: "evil" } },
    ]) {
      await expect(
        actor().invoke({ operation: "read", input: { path: "/v1.0/me/messages", ...extra } }),
      ).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only the approved plain-text fields after confirming the sender", async () => {
    const fetch = rs
      .fn()
      .mockResolvedValueOnce(
        Response.json({ mail: null, userPrincipalName: "guardian@example.com" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    rs.stubGlobal("fetch", fetch);
    expect(await actor().invoke({ operation: "send", input: message })).toMatchObject({
      status: 202,
      data: null,
    });
    const [url, init] = fetch.mock.calls[1];
    expect(url.pathname).toBe("/v1.0/me/sendMail");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(outlookSendMailBody(message));
    expect(JSON.parse(init.body)).toEqual({
      message: {
        subject: message.subject,
        body: { contentType: "Text", content: message.body },
        toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("refuses a queued send after the connection reaches another mailbox", async () => {
    const fetch = rs.fn().mockResolvedValue(Response.json({ mail: "someone-else@example.com" }));
    rs.stubGlobal("fetch", fetch);
    await expect(actor().invoke({ operation: "send", input: message })).rejects.toThrow(
      "does not match",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses hidden recipients, header injection and extra fields", async () => {
    const fetch = rs.fn();
    rs.stubGlobal("fetch", fetch);
    for (const input of [
      { ...message, cc: ["hidden@example.com"] },
      { ...message, to: ["a@example.com, hidden@example.com"] },
      { ...message, subject: "Hi\r\nBcc: hidden@example.com" },
      { ...message, replyToMessageId: "abc" },
    ]) {
      await expect(actor().invoke({ operation: "send", input })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the sender from mail, else the user principal name", () => {
    expect(outlookSenderAddress({ mail: "A@Example.com", userPrincipalName: "b@x.com" })).toBe(
      "a@example.com",
    );
    expect(outlookSenderAddress({ mail: null, userPrincipalName: "B@x.com" })).toBe("b@x.com");
    expect(outlookSenderAddress({})).toBeNull();
  });

  it("surfaces a refused token so the connection can renew", async () => {
    rs.stubGlobal("fetch", rs.fn().mockResolvedValue(Response.json({}, { status: 401 })));
    await expect(
      actor().invoke({ operation: "read", input: { path: "/v1.0/me" } }),
    ).rejects.toMatchObject({ name: "CredentialRejected" });
  });
});
