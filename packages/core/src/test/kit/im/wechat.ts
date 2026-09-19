import { WechatAdapter } from "../../../channels/wechat.js";
import { ImFixtureServer, deferred, type FixtureRequest } from "./server.js";

export const WECHAT_ORIGIN = "https://ilinkai.weixin.qq.com";
export const WECHAT_USER = "fixture-user@im.wechat";
export class WechatApiFixture {
  readonly server: ImFixtureServer = new ImFixtureServer((request) => this.route(request));
  readonly messages: Record<string, unknown>[] = [];
  readonly uploads: Uint8Array[] = [];
  private updates: Record<string, unknown>[] = [];
  private cursor = 0;
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
  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== WECHAT_ORIGIN)
      throw new Error(`WeChat fixture blocked external origin: ${url.origin}`);
    return this.server.fetch(`${this.server.url}${url.pathname}${url.search}`, init);
  };
  createAdapter(statePath: string) {
    return new WechatAdapter(
      {
        token: "fixture-token",
        baseUrl: WECHAT_ORIGIN,
        accountId: "fixture-bot",
        connectedAt: new Date(0).toISOString(),
        statePath,
      },
      this.fetch,
    );
  }
  emitMessage(text: string, id = String(++this.cursor)) {
    this.updates.push({
      message_id: id,
      from_user_id: WECHAT_USER,
      to_user_id: "fixture-bot",
      message_type: 1,
      message_state: 2,
      create_time_ms: Date.now(),
      context_token: "fixture-context",
      item_list: [{ type: 1, text_item: { text } }],
    });
    for (const resolve of [...this.wake]) resolve();
  }

  private async route({ method, path, body, headers, signal, files }: FixtureRequest) {
    if (path === "/cdn/upload" && method === "POST") {
      this.uploads.push(...files.map((file) => file.bytes));
      return { body: {}, headers: { "x-encrypted-param": "fixture-upload" }, accepted: true };
    }
    if (headers.get("authorization") !== "Bearer fixture-token")
      return { status: 401, body: { ret: -1, errmsg: "invalid token" } };
    if (method !== "POST") return undefined;
    if (path === "/ilink/bot/getupdates") {
      this.poll.resolve();
      if (!this.updates.length && !signal.aborted)
        await new Promise<void>((resolve) => {
          const finish = () => {
            this.wake.delete(finish);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          this.wake.add(finish);
          signal.addEventListener("abort", finish, { once: true });
        });
      return {
        body: { ret: 0, msgs: this.updates.splice(0), get_updates_buf: String(this.cursor) },
      };
    }
    if (path === "/ilink/bot/sendmessage") {
      const message = body.msg as Record<string, unknown>;
      if (!message || message.context_token !== "fixture-context")
        return { body: { ret: -1, errmsg: "missing conversation context" } };
      this.messages.push(structuredClone(message));
      return { body: { ret: 0 }, accepted: true };
    }
    if (path === "/ilink/bot/getconfig")
      return { body: { ret: 0, typing_ticket: "fixture-ticket" } };
    if (path === "/ilink/bot/sendtyping") return { body: { ret: 0 } };
    if (path === "/ilink/bot/getuploadurl")
      return { body: { ret: 0, upload_full_url: `${WECHAT_ORIGIN}/cdn/upload` } };
    return undefined;
  }
}
