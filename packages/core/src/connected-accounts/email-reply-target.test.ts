import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { MailProvider, RomeMailListItem } from "../lib/rome-cloud-mail.js";
import { type ResolvedEmailReplyTarget, resolveEmailReplyTarget } from "./email-reply-target.js";

function item(
  threadId: string,
  providerMessageId = "message",
  labels: string[] = ["sent"],
): RomeMailListItem {
  return {
    threadId,
    providerMessageId,
    receivedAt: "2020-01-01T00:00:00.000Z",
    labels,
  };
}

const bySentLabel = { isOutbound: (listed: RomeMailListItem) => listed.labels.includes("sent") };

function inbound(messageId: string): ResolvedEmailReplyTarget {
  return { messageId, outbound: false, complete: true };
}

function sent(messageId: string, complete = true): ResolvedEmailReplyTarget {
  return { messageId, outbound: true, complete };
}

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("resolveEmailReplyTarget", () => {
  afterEach(() => {
    rs.useRealTimers();
  });

  it("prefers the newest received message over newer messages the inbox sent", async () => {
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [
        item("wanted", "sent-newest"),
        item("other", "other-inbound", ["received"]),
        item("wanted", "inbound-newest", ["received", "unread"]),
        item("wanted", "sent-older"),
        item("wanted", "inbound-older", ["received"]),
      ],
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).resolves.toEqual(
      inbound("inbound-newest"),
    );
  });

  it("finds a received message on a later page past the inbox's own sends", async () => {
    const listMessages = rs
      .fn<MailProvider["listMessages"]>()
      .mockResolvedValueOnce({ messages: [item("wanted", "sent-1")], nextPageToken: "page-2" })
      .mockResolvedValueOnce({ messages: [item("wanted", "inbound", ["received"])] });

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).resolves.toEqual(
      inbound("inbound"),
    );
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("falls back to the newest sent message when the thread has no received mail", async () => {
    const listMessages = rs
      .fn<MailProvider["listMessages"]>()
      .mockResolvedValueOnce({
        messages: [item("wanted", "sent-newest"), item("other", "x", ["received"])],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({ messages: [item("wanted", "sent-older")] });

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).resolves.toEqual(
      sent("sent-newest"),
    );
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("classifies direction with the caller's predicate", async () => {
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [
        { ...item("wanted", "from-self", []), from: "Rome <rome@example.com>" },
        { ...item("wanted", "from-alice", []), from: "Alice <alice@example.com>" },
      ],
    }));

    await expect(
      resolveEmailReplyTarget({ listMessages }, "wanted", {
        isOutbound: (listed) => listed.from?.includes("rome@example.com") ?? false,
      }),
    ).resolves.toEqual(inbound("from-alice"));
  });

  it("rejects when the time budget ends with no match and stops reading pages", async () => {
    rs.useFakeTimers();
    let page = 0;
    const listMessages = rs.fn<MailProvider["listMessages"]>(() => {
      page += 1;
      return after(400, { messages: [item("other")], nextPageToken: `page-${page}` });
    });

    const result = resolveEmailReplyTarget({ listMessages }, "wanted", {
      ...bySentLabel,
      budgetMs: 1_000,
    }).then(
      () => new Error("expected a rejection"),
      (err: unknown) => err,
    );
    await rs.advanceTimersByTimeAsync(10_000);

    expect(String(await result)).toContain("took longer than 1s. No email was sent");
    expect(listMessages).toHaveBeenCalledTimes(3);
  });

  it("returns the sent fallback when the time budget ends before a received match", async () => {
    rs.useFakeTimers();
    let page = 0;
    const listMessages = rs.fn<MailProvider["listMessages"]>(() => {
      page += 1;
      return after(400, {
        messages: [page === 1 ? item("wanted", "sent-1") : item("other")],
        nextPageToken: `page-${page}`,
      });
    });

    const result = resolveEmailReplyTarget({ listMessages }, "wanted", {
      ...bySentLabel,
      budgetMs: 1_000,
    });
    await rs.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual(sent("sent-1", false));
  });

  it("returns the sent fallback when a later page fails", async () => {
    const listMessages = rs
      .fn<MailProvider["listMessages"]>()
      .mockResolvedValueOnce({ messages: [item("wanted", "sent-1")], nextPageToken: "page-2" })
      .mockRejectedValueOnce(new Error("mail list unavailable"));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).resolves.toEqual(
      sent("sent-1", false),
    );
  });

  it("finds the newest matching message without a history cutoff or body fetch", async () => {
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [item("other"), item("wanted", "newest"), item("wanted", "older")],
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).resolves.toEqual(
      sent("newest"),
    );
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

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).resolves.toEqual(
      sent("found"),
    );
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

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).rejects.toThrow(
      "replyToMessageId",
    );
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it("skips a blank reply target rather than authorizing a fresh send", async () => {
    const listMessages = rs.fn<MailProvider["listMessages"]>(async () => ({
      messages: [item("wanted", "   "), item("wanted", "valid")],
    }));

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).resolves.toEqual(
      sent("valid"),
    );
  });

  it("stops a cursor cycle without requesting any page twice", async () => {
    const listMessages = rs
      .fn<MailProvider["listMessages"]>()
      .mockResolvedValueOnce({ messages: [], nextPageToken: "a" })
      .mockResolvedValueOnce({ messages: [], nextPageToken: "b" })
      .mockResolvedValueOnce({ messages: [], nextPageToken: "a" });

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).rejects.toThrow(
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

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).rejects.toThrow(
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

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).rejects.toThrow(
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
      const result = resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel);
      if (position === 1999) {
        await expect(result).resolves.toEqual(sent("message"));
      } else {
        await expect(result).rejects.toThrow("No email was sent");
      }
      expect(listMessages).toHaveBeenCalledTimes(1);
    }
  });

  it("propagates a provider failure without retrying", async () => {
    const error = new Error("mail list unavailable");
    const listMessages = rs.fn<MailProvider["listMessages"]>().mockRejectedValue(error);

    await expect(resolveEmailReplyTarget({ listMessages }, "wanted", bySentLabel)).rejects.toBe(
      error,
    );
    expect(listMessages).toHaveBeenCalledTimes(1);
  });
});
