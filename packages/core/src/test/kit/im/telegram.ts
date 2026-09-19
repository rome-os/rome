import { Bot } from "grammy";
import { TelegramAdapter } from "../../../channels/telegram.js";
import { ImFixtureServer, deferred, type FixtureRequest } from "./server.js";

export const TELEGRAM_TOKEN = "123456:fixture-token";
const TELEGRAM_BOT = { id: 123456, is_bot: true, first_name: "Rome", username: "rome_fixture_bot" };
export class TelegramApiFixture {
  readonly server: ImFixtureServer = new ImFixtureServer((request) => this.route(request));
  readonly messages = new Map<number, Record<string, unknown>>();
  private updates: Array<Record<string, unknown> & { update_id: number }> = [];
  private nextId = 1;
  private poll = deferred();
  private wake = new Set<() => void>();

  async start() {
    await this.server.start();
    return this;
  }
  async close() {
    await this.server.close();
  }
  untilPolling() {
    return this.poll.promise;
  }
  readonly createBot = (token: string) =>
    new Bot(token, {
      client: {
        apiRoot: this.server.url,
        // grammy's Node transport supplies abort-controller signals and Readable bodies.
        // Bridge those to native fetch without replacing grammy's multipart serializer.
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
          try {
            const options = { ...init, signal: controller.signal, duplex: "half" };
            return await this.server.fetch(input, options);
          } finally {
            init?.signal?.removeEventListener("abort", abort);
          }
        },
      },
    });
  createAdapter() {
    return new TelegramAdapter({ botToken: TELEGRAM_TOKEN }, this.createBot);
  }

  emitMessage(text: string, chatId = 123, updateId = this.nextId++) {
    const message = {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Alice" },
      from: { id: chatId, is_bot: false, first_name: "Alice" },
      text,
    };
    this.updates.push({ update_id: updateId, message });
    for (const resolve of [...this.wake]) resolve();
    return message;
  }

  private async route({ method, path, body, files, signal }: FixtureRequest) {
    if (method !== "POST" || !path.startsWith(`/bot${TELEGRAM_TOKEN}/`)) return undefined;
    const operation = path.slice(path.lastIndexOf("/") + 1);
    if (operation === "getMe")
      return {
        body: {
          ok: true,
          result: TELEGRAM_BOT,
        },
      };
    if (
      operation === "deleteWebhook" ||
      operation === "sendChatAction" ||
      operation === "answerCallbackQuery"
    )
      return { body: { ok: true, result: true } };
    if (operation === "getUpdates") {
      this.poll.resolve();
      const offset = Number(body.offset ?? 0);
      this.updates = this.updates.filter((update) => update.update_id >= offset);
      if (!this.updates.length && Number(body.timeout ?? 0) > 0 && !signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            this.wake.delete(finish);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          this.wake.add(finish);
          signal.addEventListener("abort", finish, { once: true });
        });
      }
      return { body: { ok: true, result: this.updates } };
    }
    if (operation === "editMessageText") {
      const message = this.messages.get(Number(body.message_id));
      if (!message || Number((message.chat as { id: number }).id) !== Number(body.chat_id))
        return {
          status: 400,
          body: {
            ok: false,
            error_code: 400,
            description: "Bad Request: message to edit not found",
          },
        };
      const text = String(body.text ?? "");
      if (!text.length || text.length > 4096)
        return {
          body: { ok: false, error_code: 400, description: "Bad Request: invalid text length" },
        };
      message.text = body.text;
      message.edit_date = Math.floor(Date.now() / 1000);
      return { body: { ok: true, result: message }, accepted: true };
    }
    if (
      ["sendMessage", "sendPhoto", "sendDocument", "sendVideo", "sendAudio", "sendVoice"].includes(
        operation,
      )
    ) {
      if (String(body.text ?? "").length > 4096)
        return {
          body: { ok: false, error_code: 400, description: "Bad Request: message is too long" },
        };
      const message = {
        message_id: this.nextId++,
        from: TELEGRAM_BOT,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(body.chat_id), type: "private" },
        text: body.text,
        caption: body.caption,
        ...(files.length
          ? { files: files.map((file) => ({ name: file.name, size: file.bytes.length })) }
          : {}),
        ...(body.reply_parameters
          ? {
              reply_to_message: structuredClone(
                this.messages.get(
                  Number((body.reply_parameters as { message_id: number }).message_id),
                ),
              ),
            }
          : {}),
      };
      this.messages.set(message.message_id, message);
      return { body: { ok: true, result: message }, accepted: true };
    }
    return undefined;
  }
}
