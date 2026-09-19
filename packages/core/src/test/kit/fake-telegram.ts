// FakeTelegramApi — plays the Telegram Bot API server behind a REAL grammy Bot.
//
// Instead of replicating grammy's semantics in a hand-rolled stub (which
// drifts), this fake uses grammy's own test seams, so middleware filters,
// init, and the long-polling lifecycle all run grammy's production code:
//
// - `new Bot(token, { botInfo })` skips the network getMe in init();
// - an API transformer (`bot.api.config.use`) intercepts every outbound
//   call at the wire layer and answers with canned Telegram JSON — the
//   recorded (method, payload) pairs ARE the outbound HTTP contract;
// - `getUpdates` returns a promise that settles only on abort, so
//   `bot.start()` runs a real long poll and `bot.stop()` really ends it;
// - incoming updates go through `bot.handleUpdate(update)`, exercising the
//   real filter middleware (`bot.on(["message", "channel_post"], …)`).
//
// Scope: the transformer sits ABOVE grammy's HTTP caller, so recorded
// payloads are the pre-serialization Bot API payloads — `InputFile` values
// arrive as instances, before multipart encoding opens the file. That is the
// adapter's outbound contract ("called sendDocument with an InputFile for
// this path"); grammy's serialization/transport below the seam is grammy's
// own tested code and out of scope here. Methods the fake does not model are
// a hard error, so a new adapter API call can't silently pass.
//
// The one cast below is the wire-shim boundary: canned JSON responses typed
// loosely against grammy's per-method generics. It is not an internal
// collaborator stub.

import { Bot, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

/**
 * One outbound Bot API call, captured pre-serialization: the method name and
 * the payload grammy was asked to send (`InputFile` values are still
 * instances — multipart encoding happens below this seam).
 */
export interface TelegramApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/**
 * Messaging methods the fake models. Any other method (beyond the lifecycle
 * plumbing handled explicitly in `answer`) throws, so an adapter that grows a
 * new API call fails loudly until the fake is taught its semantics.
 */
const SUPPORTED_SEND_METHODS = new Set([
  "editMessageText",
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendAudio",
  "sendDocument",
]);

type TelegramApiResponse =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string };

const FAKE_BOT_INFO: UserFromGetMe = {
  id: 424242,
  is_bot: true,
  first_name: "FakeBot",
  username: "fake_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

export class FakeTelegramApi {
  /** Tokens passed through the createBot factory, in construction order. */
  readonly tokens: string[] = [];
  /**
   * Every messaging API request, in send order — including requests the
   * fake rejected via `failNextSend` (the server still received them).
   * Payloads are pre-serialization (see `TelegramApiCall`). Lifecycle
   * plumbing (getMe/deleteWebhook/getUpdates) is excluded.
   */
  readonly sent: TelegramApiCall[] = [];
  /** True while a getUpdates long poll is in flight (started, not stopped). */
  polling = false;

  private bot?: Bot;
  private files = new Map<string, string>();
  private sendFailures: string[] = [];
  private pollingWaiters: (() => void)[] = [];
  private nextMessageId = 1000;
  private nextUpdateId = 1;

  /**
   * Bind as the adapter's `createBot` factory:
   * `new TelegramAdapter({ botToken }, fake.createBot)`.
   */
  readonly createBot = (botToken: string): Bot => {
    this.tokens.push(botToken);
    const bot = new Bot(botToken, { botInfo: FAKE_BOT_INFO });
    bot.api.config.use(((_prev: unknown, method: string, payload: unknown, signal?: AbortSignal) =>
      this.answer(method, payload, signal)) as unknown as Transformer);
    this.bot = bot;
    return bot;
  };

  private async answer(
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<TelegramApiResponse> {
    switch (method) {
      case "getMe":
        return { ok: true, result: FAKE_BOT_INFO };
      case "deleteWebhook":
        return { ok: true, result: true };
      case "getUpdates":
        return this.longPoll(signal);
      case "getFile": {
        const fileId = (payload as { file_id: string }).file_id;
        const filePath = this.files.get(fileId);
        if (filePath === undefined) {
          return { ok: false, error_code: 400, description: "Bad Request: invalid file_id" };
        }
        return {
          ok: true,
          result: { file_id: fileId, file_unique_id: `unique-${fileId}`, file_path: filePath },
        };
      }
      default: {
        if (!SUPPORTED_SEND_METHODS.has(method)) {
          throw new Error(
            `FakeTelegramApi: unmodeled Bot API method "${method}" — add it to the fake before the adapter may call it`,
          );
        }
        this.sent.push({ method, payload: payload as Record<string, unknown> });
        const failure = this.sendFailures.shift();
        if (failure) return { ok: false, error_code: 400, description: failure };
        return {
          ok: true,
          result: {
            message_id:
              method === "editMessageText"
                ? (payload as { message_id: number }).message_id
                : this.nextMessageId++,
            date: 0,
            chat: {
              id: Number((payload as { chat_id: unknown }).chat_id),
              type: "private",
              first_name: "FakeChat",
            },
          },
        };
      }
    }
  }

  /**
   * grammy's polling loop passes its abort signal to getUpdates — that call
   * long-polls until bot.stop() aborts it. bot.stop() then issues one final
   * signal-less getUpdates to confirm the offset; answer it immediately.
   */
  private longPoll(signal?: AbortSignal): Promise<TelegramApiResponse> {
    if (!signal) return Promise.resolve({ ok: true, result: [] });
    this.polling = true;
    this.pollingWaiters.splice(0).forEach((wake) => wake());
    return new Promise((_resolve, reject) => {
      const abort = () => {
        this.polling = false;
        const err = new Error("getUpdates long poll aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Resolves once the bot's polling loop has issued its first getUpdates.
   * Await this after `adapter.start()` — the adapter intentionally does not
   * await `bot.start()`, so polling begins asynchronously.
   */
  untilPolling(): Promise<void> {
    if (this.polling) return Promise.resolve();
    return new Promise((resolve) => this.pollingWaiters.push(resolve));
  }

  /**
   * Deliver an incoming Telegram update through grammy's real middleware,
   * as long polling would. `update_id` is filled in if omitted.
   */
  async emitUpdate(update: Record<string, unknown>): Promise<void> {
    if (!this.bot || !this.polling) {
      throw new Error(
        "FakeTelegramApi: cannot deliver an update while the transport is not polling (adapter not started, or already stopped)",
      );
    }
    await this.bot.handleUpdate({
      update_id: this.nextUpdateId++,
      ...update,
    } as unknown as Update);
  }

  /** Make the server reject the next messaging request with a 400. */
  failNextSend(description: string): void {
    this.sendFailures.push(description);
  }

  /** Register a file so `getFile(fileId)` resolves with its file_path. */
  addFile(fileId: string, filePath: string): void {
    this.files.set(fileId, filePath);
  }
}
