import { traceLarkHttp } from "../../../channels/diagnostics/lark-trace.js";
import {
  createLarkChannel,
  Domain,
  defaultHttpInstance,
  DefaultCache,
  LoggerLevel,
  type HttpInstance,
  type HttpRequestOptions,
} from "@larksuiteoapi/node-sdk";
import { FeishuAdapter, type FeishuConfig } from "../../../channels/feishu.js";
import { ImFixtureServer, deferred, type FixtureRequest } from "./server.js";
import { encodeLarkFrame, decodeLarkFrame } from "./lark-frame.js";

export const LARK_CHAT = "oc_fixture_chat";
export const LARK_USER = "ou_fixture_alice";
const CLIENT_CONFIG = {
  PingInterval: 60,
  ReconnectCount: 2,
  ReconnectInterval: 0.01,
  ReconnectNonce: 0,
};
interface LarkMessage {
  message_id: string;
  chat_id: string;
  msg_type: string;
  body: { content: string };
  create_time: string;
  deleted: boolean;
  updated: boolean;
  update_time?: string;
  sender?: { id: string; id_type: string; sender_type: string; tenant_key: string };
  parent_id?: string;
  root_id?: string;
  thread_id?: string;
}

/** Starts an isolated HTTP/WebSocket peer. Disconnect its clients before calling close(). */
export function createLarkServerStub(): Promise<LarkApiFixture> {
  return new LarkApiFixture().start();
}

export class LarkApiFixture {
  readonly server: ImFixtureServer = new ImFixtureServer((request) => this.route(request));
  readonly messages = new Map<string, LarkMessage>();
  readonly acknowledged: string[] = [];
  private nextId = 1;
  private connected = deferred();
  private acknowledgements = new Map<string, ReturnType<typeof deferred<void>>>();
  readonly appId = "cli_0123456789abcdef";
  readonly appSecret = "fixture-secret";

  constructor() {
    this.server.ws.on("connection", (peer) => {
      peer.on("message", (raw) => {
        try {
          const frame = decodeLarkFrame(Buffer.from(raw as Buffer));
          if (frame.method === 0 && frame.headers.type === "ping") {
            this.connected.resolve();
            peer.send(
              encodeLarkFrame({
                ...frame,
                headers: { type: "pong" },
                payload: Buffer.from(JSON.stringify(CLIENT_CONFIG)),
              }),
            );
            return;
          }
          if (frame.method !== 1 || frame.headers.type !== "event")
            throw new Error("Unmodeled Lark client frame");
          const result = JSON.parse(Buffer.from(frame.payload).toString());
          if (result.code !== 200) throw new Error(`Lark event rejected: ${result.code}`);
          this.acknowledged.push(frame.headers.message_id);
          this.acknowledgements.get(frame.headers.message_id)?.resolve();
          this.acknowledgements.delete(frame.headers.message_id);
        } catch (error) {
          this.server.errors.push(String(error));
        }
      });
    });
  }

  untilConnected() {
    return this.connected.promise;
  }

  async start() {
    await this.server.start();
    return this;
  }
  async close() {
    for (const pending of this.acknowledgements.values()) pending.resolve();
    this.acknowledgements.clear();
    await this.server.close();
  }

  createAdapter(config: Partial<FeishuConfig> = {}) {
    return new FeishuAdapter(
      { appId: this.appId, appSecret: this.appSecret, ...config },
      (credentials) => this.createChannel(credentials),
    );
  }

  createChannel(
    credentials: Pick<FeishuConfig, "appId" | "appSecret" | "domain"> = {
      appId: this.appId,
      appSecret: this.appSecret,
    },
  ) {
    const domain = credentials.domain === "lark" ? Domain.Lark : Domain.Feishu;
    const request = <T, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> => {
      if (
        !options.url ||
        new URL(options.url).origin !==
          (domain === Domain.Lark ? "https://open.larksuite.com" : "https://open.feishu.cn")
      )
        throw new Error("Lark fixture blocked external HTTP request");
      const original = new URL(options.url);
      const localOptions = {
        ...options,
        url: `${this.server.url}${original.pathname}${original.search}`,
        proxy: false as const,
        maxRedirects: 0,
      };
      return defaultHttpInstance.request<T, R, D>(localOptions);
    };
    const httpInstance = { request } as HttpInstance;
    for (const method of ["get", "delete", "head", "options"] as const) {
      httpInstance[method] = (url, options) => request({ ...options, url, method });
    }
    for (const method of ["post", "put", "patch"] as const) {
      httpInstance[method] = (url, data, options) => request({ ...options, url, data, method });
    }
    return createLarkChannel({
      ...credentials,
      domain,
      httpInstance: traceLarkHttp(credentials.domain === "lark" ? "lark" : "feishu", httpInstance),
      transport: "websocket",
      includeRawEvent: true,
      cache: new DefaultCache(),
      outbound: { markdownConverter: "builtin" },
      loggerLevel: LoggerLevel.error,
    });
  }

  async emitMessage(text: string, eventId = `evt_${this.nextId++}`, chatId = LARK_CHAT) {
    this.messages.set(`om_${eventId}`, {
      message_id: `om_${eventId}`,
      chat_id: chatId,
      msg_type: "text",
      body: { content: JSON.stringify({ text }) },
      create_time: String(Date.now()),
      deleted: false,
      updated: false,
    });
    return this.emitEvent({
      schema: "2.0",
      header: {
        event_id: eventId,
        event_type: "im.message.receive_v1",
        create_time: String(Date.now()),
        tenant_key: "fixture-tenant",
        app_id: this.appId,
      },
      event: {
        sender: {
          sender_id: { open_id: LARK_USER },
          sender_type: "user",
          tenant_key: "fixture-tenant",
        },
        message: {
          message_id: `om_${eventId}`,
          chat_id: chatId,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
          create_time: String(Date.now()),
          mentions: [],
        },
      },
    });
  }

  async emitEvent(event: {
    header: { event_id: string; [key: string]: unknown };
    [key: string]: unknown;
  }) {
    if (!this.server.ws.clients.size) throw new Error("Lark gateway has no connected SDK");
    const sequence = this.nextId++;
    // Redeliveries share an event id but each frame must own its ACK waiter.
    const id = `${event.header.event_id}:${sequence}`;
    const pending = deferred();
    this.acknowledgements.set(id, pending);
    const payload = encodeLarkFrame({
      sequence,
      method: 1,
      headers: { type: "event", message_id: id, sum: "1", seq: "0", trace_id: `trace_${id}` },
      payload: Buffer.from(JSON.stringify(event)),
    });
    for (const peer of this.server.ws.clients) peer.send(payload);
    await pending.promise;
  }

  private route({ method, path, body, headers, query }: FixtureRequest) {
    if (method === "POST" && path === "/callback/ws/endpoint") {
      if (body.AppID !== this.appId || body.AppSecret !== this.appSecret)
        return { body: { code: 1000040343, msg: "invalid credential", data: {} } };
      return {
        body: {
          code: 0,
          data: {
            URL: `${this.server.gatewayUrl}?device_id=fixture&service_id=1`,
            ClientConfig: CLIENT_CONFIG,
          },
        },
      };
    }
    if (method === "POST" && path === "/open-apis/auth/v3/tenant_access_token/internal") {
      return body.app_id === this.appId && body.app_secret === this.appSecret
        ? { body: { code: 0, tenant_access_token: "fixture-tenant-token", expire: 7200 } }
        : { status: 401, body: { code: 99991663, msg: "invalid credential" } };
    }
    if (headers.get("authorization") !== "Bearer fixture-tenant-token")
      return { status: 401, body: { code: 99991663, msg: "invalid token" } };
    if (method === "GET" && path === "/open-apis/bot/v3/info")
      return { body: { code: 0, bot: { open_id: "ou_fixture_bot", app_name: "Rome" } } };
    if (method === "POST" && path === "/open-apis/im/v1/messages") {
      const chatId =
        query.get("receive_id_type") === "open_id" && body.receive_id === LARK_USER
          ? LARK_CHAT
          : String(body.receive_id);
      return this.createMessage(chatId, body);
    }
    const match = path.match(
      /^\/open-apis\/im\/v1\/messages\/([^/]+)(?:\/(reply|reactions)(?:\/([^/]+))?)?$/,
    );
    if (!match) return undefined;
    const [, id, operation] = match;
    const message = this.messages.get(id);
    if (operation === "reactions") {
      if (method === "POST")
        return { body: { code: 0, data: { reaction_id: `reaction_${this.nextId++}` } } };
      if (method === "DELETE") return { body: { code: 0, data: {} } };
      return undefined;
    }
    if (!message) return { status: 400, body: { code: 230011, msg: "message not found" } };
    if (operation === "reply" && method === "POST")
      return this.createMessage(message.chat_id, body, message);
    if (method === "GET")
      return {
        body: {
          code: 0,
          msg: "success",
          data: {
            items: [
              {
                ...message,
                message_position: String([...this.messages.keys()].indexOf(id) + 1),
                ...(message.thread_id
                  ? {
                      thread_message_position: String(
                        [...this.messages.values()]
                          .filter((item) => item.thread_id === message.thread_id && item.parent_id)
                          .findIndex((item) => item.message_id === id),
                      ),
                    }
                  : {}),
              },
            ],
          },
        },
      };
    if (method === "PATCH" || method === "PUT") {
      message.body.content = this.messageContent(body);
      message.updated = true;
      message.update_time = String(Date.now());
      return { body: { code: 0, msg: "success", data: message }, accepted: true };
    }
    return undefined;
  }

  private createMessage(chatId: string, body: Record<string, unknown>, parent?: LarkMessage) {
    if (parent && body.reply_in_thread) {
      const root = this.messages.get(parent.root_id ?? parent.message_id)!;
      root.thread_id ??= root.message_id.replace(/^om_/, "omt_");
      parent.thread_id = root.thread_id;
    }
    const now = String(Date.now());
    const message = {
      message_id: `om_${this.nextId++}`,
      chat_id: chatId,
      msg_type: String(body.msg_type),
      body: { content: this.messageContent(body) },
      create_time: now,
      update_time: now,
      sender: {
        id: this.appId,
        id_type: "app_id",
        sender_type: "app",
        tenant_key: "fixture-tenant",
      },
      ...(parent
        ? {
            parent_id: parent.message_id,
            root_id: parent.root_id ?? parent.message_id,
            ...(body.reply_in_thread ? { thread_id: parent.thread_id } : {}),
          }
        : {}),
      deleted: false,
      updated: false,
    };
    this.messages.set(message.message_id, message);
    return { body: { code: 0, msg: "success", data: message }, accepted: true };
  }

  private messageContent(body: Record<string, unknown>): string {
    const content = String(body.content);
    if (body.msg_type !== "post") return content;
    const localized = JSON.parse(content);
    const post = localized.zh_cn ?? localized.en_us;
    if (!post) throw new Error("Unmodeled Lark post locale");
    // Only captured text/link elements model server normalization. Other tags stay synthetic.
    if (
      post.content
        .flat()
        .some((element: Record<string, unknown>) => !["text", "a"].includes(String(element.tag)))
    )
      return content;
    const rows = post.content.map((row: Record<string, unknown>[]) =>
      row.map((element) =>
        element.tag === "text" || element.tag === "a"
          ? { ...element, style: element.style ?? [] }
          : element,
      ),
    );
    return JSON.stringify({ title: post.title ?? "", content: rows, content_v2: rows });
  }
}
