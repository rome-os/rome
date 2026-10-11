import { describe, expect, it, rs } from "@rstest/core";
import type { MailProvider, RomeMailListItem } from "../lib/rome-cloud-mail.js";
import { resolveEmailReplyTarget } from "./email-reply-target.js";

function item(threadId: string, providerMessageId = "message"): RomeMailListItem {
  return {
    threadId,
    providerMessageId,
    receivedAt: "2020-01-01T00:00:00.000Z",
    labels: ["sent"],
  };
}

describe("resolveEmailReplyTarget", () => {
  it("finds the newest matching message without a history cutoff or body fetch", async () => {
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [item("other"), item("wanted", "newest"), item("wanted", "older")],
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).resolves.toBe("newest");
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(listMessages).toHaveBeenCalledWith({
      ascending: false,
      limit: 100,
      pageToken: undefined,
    });
  });

  it("follows pages and empty pages that still carry a cursor", async () => {
    const listMessages = rs
      .fn<MailProvider["listMessages"]>()
      .mockResolvedValueOnce({ messages: [item("other")], nextPageToken: "page-2" })
      .mockResolvedValueOnce({ messages: [], nextPageToken: "page-3" })
      .mockResolvedValueOnce({ messages: [item("wanted", "found")] });

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).resolves.toBe("found");
    expect(listMessages.mock.calls.map(([params]) => params?.pageToken)).toEqual([
      undefined,
      "page-2",
      "page-3",
    ]);
  });

  it("rejects a missing thread and suggests an explicit provider message ID", async () => {
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [item("other")],
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).rejects.toThrow(
      "replyToMessageId",
    );
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it("skips a blank reply target rather than authorizing a fresh send", async () => {
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [item("wanted", "   "), item("wanted", "valid")],
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).resolves.toBe("valid");
  });

  it("stops a cursor cycle without requesting any page twice", async () => {
    const listMessages = rs
      .fn<MailProvider["listMessages"]>()
      .mockResolvedValueOnce({ messages: [], nextPageToken: "a" })
      .mockResolvedValueOnce({ messages: [], nextPageToken: "b" })
      .mockResolvedValueOnce({ messages: [], nextPageToken: "a" });

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).rejects.toThrow(
      "No email was sent",
    );
    expect(listMessages).toHaveBeenCalledTimes(3);
  });

  it("bounds an endless stream of empty pages", async () => {
    let pages = 0;
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [],
      nextPageToken: `page-${++pages}`,
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).rejects.toThrow(
      "lookup limits",
    );
    expect(listMessages).toHaveBeenCalledTimes(20);
  });

  it("bounds mailbox scanning to 2,000 messages", async () => {
    let pages = 0;
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: Array.from({ length: 100 }, () => item("other")),
      nextPageToken: `page-${++pages}`,
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).rejects.toThrow(
      "lookup limits",
    );
    expect(listMessages).toHaveBeenCalledTimes(20);
  });

  it("accepts a match at the scan boundary but not beyond it", async () => {
    for (const position of [1999, 2000]) {
      const messages = Array.from({ length: 2001 }, (_, index) =>
        item(index === position ? "wanted" : "other"),
      );
      const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({ messages }));
      const result = resolveEmailReplyTarget({ listMessages }, "wanted");
      if (position === 1999) {
        await expect(result).resolves.toBe("message");
      } else {
        await expect(result).rejects.toThrow("No email was sent");
      }
      expect(listMessages).toHaveBeenCalledTimes(1);
    }
  });

  it("propagates a provider failure without retrying", async () => {
    const error = new Error("mail list unavailable");
    const listMessages = rs.fn<MailProvider["listMessages"]>().mockRejectedValue(error);

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted")).rejects.toBe(error);
    expect(listMessages).toHaveBeenCalledTimes(1);
  });
});
