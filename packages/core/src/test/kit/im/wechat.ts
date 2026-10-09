import { WechatAdapter } from "../../../channels/wechat.js";
import { exemplar, loadCapture } from "./capture.js";
import textCapture from "./captures/wechat-text.capture.json" with { type: "json" };
import {
  MessageStore,
  PeerServer,
  deferred,
  type Peer,
  type PeerRequest,
  type Reply,
  type VisibleMessage,
} from "./peer.js";

export const WECHAT_ORIGIN = "https://ilinkai.weixin.qq.com";
export const WECHAT_TOKEN = "fixture-token";
/** The recipient the capture was recorded with; the bot can already reach it. */
export const WECHAT_USER = "fixture-user@im.wechat";
const WECHAT_BOT = "fixture-bot";

const capture = loadCapture(textCapture);
const MSG_TYPE_USER = 1;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_TEXT = 1;

interface WireMessage {
  to_user_id?: string;
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
}

/**
 * The iLink bot API behind Rome's own WeChat adapter, which calls the global
 * `fetch`. Install the peer with `rs.stubGlobal("fetch", peer.fetch)`; requests
 * to any other origin fail. Send responses come from
 * ./captures/wechat-text.capture.json, which records that iLink accepts a send
 * with `{ message_id }` and refuses one with HTTP 200 and a non-zero `ret`.
 */
export class WechatPeer implements Peer {
  readonly server = new PeerServer((request) => this.route(request));
  private readonly store = new MessageStore();
  private readonly reachable = new Set([WECHAT_USER]);
  private pending: Record<string, unknown>[] = [];
  private nextMessageId = exemplar<{ message_id: number }>(capture, "send").message_id;
  private cursor = 0;
  private readonly polling = deferred();
  private readonly wake = new Set<() => void>();

  static async start(): Promise<WechatPeer> {
    const peer = new WechatPeer();
    await peer.server.start();
    return peer;
  }

  close(): Promise<void> {
    return this.server.close();
  }

  untilPolling(): Promise<void> {
    return this.polling.promise;
  }

  visible(userId = WECHAT_USER): VisibleMessage[] {
    return this.store.visible(userId);
  }

  /** Stands in for the global fetch: the iLink origin goes to this peer. */
  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== WECHAT_ORIGIN)
      return Promise.reject(new Error(`WeChat peer blocked a request to ${url.origin}`));
    return this.server.fetch(`${this.server.url}${url.pathname}${url.search}`, init);
  };

  createAdapter(statePath: string): WechatAdapter {
    return new WechatAdapter({
      token: WECHAT_TOKEN,
      baseUrl: WECHAT_ORIGIN,
      accountId: WECHAT_BOT,
      connectedAt: new Date(0).toISOString(),
      statePath,
    });
  }

  /** A user's text message, delivered on the adapter's next getupdates. It
   *  carries the context token the adapter must answer with. */
  emitMessage(text: string, userId = WECHAT_USER): VisibleMessage {
    this.reachable.add(userId);
    const message = this.store.add({
      id: String(this.nextMessageId++),
      conversation: userId,
      from: "user",
      text,
    });
    this.pending.push({
      message_id: message.id,
      from_user_id: userId,
      to_user_id: WECHAT_BOT,
      message_type: MSG_TYPE_USER,
      message_state: MSG_STATE_FINISH,
      create_time_ms: Date.now(),
      context_token: `context-${userId}`,
      item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
    });
    for (const wake of [...this.wake]) wake();
    return message;
  }

  private async route({
    method,
    path,
    headers,
    body,
    signal,
  }: PeerRequest): Promise<Reply | undefined> {
    if (method !== "POST") return undefined;
    if (headers.get("authorization") !== `Bearer ${WECHAT_TOKEN}`)
      throw new Error(`WeChat request without the bot token: ${path}`);
    if (path === "/ilink/bot/getupdates") return this.getUpdates(signal);
    if (path === "/ilink/bot/sendmessage") return this.sendMessage(body.msg as WireMessage);
    return undefined;
  }

  private async getUpdates(signal: AbortSignal): Promise<Reply> {
    this.polling.resolve();
    if (!this.pending.length && !signal.aborted) {
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
    const msgs = this.pending.splice(0);
    this.cursor += msgs.length;
    return { body: { ret: 0, msgs, get_updates_buf: String(this.cursor) }, source: "synthetic" };
  }

  private sendMessage(message: WireMessage | undefined): Reply {
    const to = message?.to_user_id ?? "";
    if (!this.reachable.has(to))
      return { body: exemplar(capture, "send-invalid-recipient"), source: "capture" };
    const text = (message?.item_list ?? [])
      .map((item) => (item.type === MSG_ITEM_TEXT ? (item.text_item?.text ?? "") : ""))
      .join("");
    const stored = this.store.add({
      id: String(this.nextMessageId++),
      conversation: to,
      from: "rome",
      text,
    });
    return {
      body: {
        ...exemplar<Record<string, unknown>>(capture, "send"),
        message_id: Number(stored.id),
      },
      source: "capture",
      accepted: true,
    };
  }
}
