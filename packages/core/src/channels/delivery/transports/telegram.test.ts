import { type Api, GrammyError, HttpError } from "grammy";
import { describe, expect, it } from "@rstest/core";
import { DeliveryFailure } from "../types.js";
import { telegramTransport } from "./telegram.js";

const refusal = (error_code: number, description: string, parameters?: { retry_after: number }) =>
  new GrammyError(
    description,
    { ok: false, error_code, description, ...(parameters ? { parameters } : {}) },
    "sendMessage",
    {},
  );

/** The two Bot API calls the transport makes, answering as `api` says. */
function transportOver(api: { sendMessage?: unknown; editMessageText?: unknown }) {
  const transport = telegramTransport(api as unknown as Api);
  if (!transport.edit) throw new Error("The Telegram transport declares edit");
  return { create: transport.create, edit: transport.edit };
}

describe("telegramTransport", () => {
  it("creates a message and names it by the ids Telegram answered", async () => {
    const sent: unknown[][] = [];
    const { create } = transportOver({
      sendMessage: async (...args: unknown[]) => {
        sent.push(args);
        return { message_id: 41, chat: { id: -100 } };
      },
    });

    expect(await create("7", "hello", "12")).toEqual({ messageId: "41", conversationId: "-100" });
    expect(sent).toEqual([["7", "hello", { reply_parameters: { message_id: 12 } }]]);
  });

  it("points a message at nothing unless it answers one", async () => {
    const sent: unknown[][] = [];
    const { create } = transportOver({
      sendMessage: async (...args: unknown[]) => {
        sent.push(args);
        return { message_id: 1, chat: { id: 7 } };
      },
    });

    await create("7", "hello");
    expect(sent).toEqual([["7", "hello", {}]]);
  });

  it("treats an edit to the text already shown as done", async () => {
    const { edit } = transportOver({
      editMessageText: async () => {
        throw refusal(400, "Bad Request: message is not modified: specified new message content");
      },
    });

    await expect(edit({ messageId: "41", conversationId: "7" }, "same")).resolves.toBeUndefined();
  });

  const failureOf = async (error: unknown) => {
    const { edit } = transportOver({
      editMessageText: async () => {
        throw error;
      },
    });
    return edit({ messageId: "41", conversationId: "7" }, "text").catch(
      (failed: unknown) => failed,
    );
  };

  it("asks to wait as long as Telegram says when it rate-limits a write", async () => {
    const failure = await failureOf(
      refusal(429, "Too Many Requests: retry after 3", { retry_after: 3 }),
    );
    expect(failure).toBeInstanceOf(DeliveryFailure);
    expect(failure).toMatchObject({ kind: "rate-limited", retryAfterMs: 3000 });
  });

  it("waits a second when a rate limit names no time", async () => {
    expect(await failureOf(refusal(429, "Too Many Requests"))).toMatchObject({
      kind: "rate-limited",
      retryAfterMs: 1000,
    });
  });

  it("reports a credential Telegram no longer accepts as unauthorized", async () => {
    expect(await failureOf(refusal(401, "Unauthorized"))).toMatchObject({ kind: "unauthorized" });
    expect(await failureOf(refusal(403, "Forbidden: bot was blocked by the user"))).toMatchObject({
      kind: "unauthorized",
    });
  });

  it("reports any other refusal as rejected, which Telegram will repeat", async () => {
    expect(await failureOf(refusal(400, "Bad Request: message to edit not found"))).toMatchObject({
      kind: "rejected",
      message: "Bad Request: message to edit not found",
    });
  });

  it("reports a failed connection as unknown, since the write may have arrived", async () => {
    const failure = await failureOf(new HttpError("Network request failed", new Error("socket")));
    expect(failure).toMatchObject({ kind: "unknown", message: "Network request failed" });
  });
});
