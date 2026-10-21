import {
  Client,
  DefaultCache,
  defaultHttpInstance,
  type HttpInstance,
  LoggerLevel,
} from "@larksuiteoapi/node-sdk";
import { exemplar, loadCapture } from "./capture.js";
import postCapture from "./captures/feishu-post.capture.json" with { type: "json" };
import {
  type MessageChange,
  MessageStore,
  type Peer,
  type PeerRequest,
  PeerServer,
  type Reply,
  type VisibleMessage,
} from "./peer.js";

/** The group chat the capture was recorded in. */
export const FEISHU_CHAT = "oc_fixture_chat";
export const FEISHU_APP_ID = "cli_0123456789abcdef";
const TOKEN = "t-fixture";
/** Where the SDK sends a client's requests for the Feishu domain. */
const FEISHU_ORIGIN = "https://open.feishu.cn";

const capture = loadCapture(postCapture);
const created = exemplar<{ data: Record<string, unknown> }>(capture, "create").data;
const MISSING_ID = "om_00000000000000000000000000000000";
const MESSAGES = "/open-apis/im/v1/messages";
/** Feishu refuses a post or card whose content is larger than this. */
const CONTENT_LIMIT = 30 * 1024;
const MAX_EDITS = 20;

interface PostElement {
  tag: string;
  text?: string;
  href?: string;
}

/**
 * Feishu's message API behind a real `@larksuiteoapi/node-sdk` client, over
 * HTTP. Message answers are built from the recorded ones
 * (./captures/feishu-post.capture.json). The token and the refusals no capture
 * covers yet answer with `source: "synthetic"`.
 *
 * A post's text is what its elements say, one line per paragraph. A Markdown
 * element shows its source: the peer does not parse it into styled runs as
 * Feishu does, so the `content` of its answer holds the source as one run.
 */
export class FeishuPeer implements Peer {
  readonly server = new PeerServer((request) => this.route(request));
  private readonly store = new MessageStore();
  private readonly chats = new Set([FEISHU_CHAT]);
  /** Each message's answer content, as Feishu echoes what it holds. */
  private readonly contents = new Map<string, string>();
  private readonly times = new Map<string, { create_time: string; update_time: string }>();
  private readonly parents = new Map<string, string>();
  /** The thread each message is in, and the message each thread started from. */
  private readonly threads = new Map<string, string>();
  private readonly roots = new Map<string, string>();
  private readonly recalled = new Set<string>();
  private credentialRefused = false;
  private nextMessageId = 1;
  private nextThreadId = 1;

  static async start(): Promise<FeishuPeer> {
    const peer = new FeishuPeer();
    await peer.server.start();
    return peer;
  }

  close(): Promise<void> {
    return this.server.close();
  }

  visible(chatId: string = FEISHU_CHAT): VisibleMessage[] {
    return this.store.visible(chatId);
  }

  changes(chatId: string = FEISHU_CHAT): MessageChange[] {
    return this.store.changes(chatId);
  }

  /** The thread a message is in, if a reply opened one on it or it joined one. */
  threadOf(messageId: string): string | undefined {
    return this.threads.get(messageId);
  }

  /** A client for the app, with a token cache of its own so tests do not share one. */
  createClient(): Client {
    return new Client({
      appId: FEISHU_APP_ID,
      appSecret: "fixture-secret",
      // The SDK reads `:word` in a URL as a path parameter, so a domain with a
      // port breaks every call. The client keeps Feishu's domain, and its
      // requests are sent here instead.
      httpInstance: this.redirected(),
      cache: new DefaultCache(),
      // The client logs every refusal, and tests make many on purpose.
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
      loggerLevel: LoggerLevel.fatal,
    });
  }

  private redirected(): HttpInstance {
    const http = defaultHttpInstance as unknown as HttpInstance;
    const here = (url = "") => {
      if (!URL.canParse(url) || new URL(url).origin !== FEISHU_ORIGIN)
        throw new Error(`Peer blocked a request to ${url}`);
      return this.server.url + url.slice(FEISHU_ORIGIN.length);
    };
    return {
      request: (options) => http.request({ ...options, url: here(options.url) }),
      get: (url, options) => http.get(here(url), options),
      delete: (url, options) => http.delete(here(url), options),
      head: (url, options) => http.head(here(url), options),
      options: (url, options) => http.options(here(url), options),
      post: (url, data, options) => http.post(here(url), data, options),
      put: (url, data, options) => http.put(here(url), data, options),
      patch: (url, data, options) => http.patch(here(url), data, options),
    };
  }

  /** A user's text message in the chat, for Rome's reply to answer. */
  userMessage(text: string, chatId = FEISHU_CHAT): VisibleMessage {
    this.chats.add(chatId);
    return this.store.add({ id: this.messageId(), conversation: chatId, from: "user", text });
  }

  /** The user recalls their message, so a reply to it is refused. */
  recall(messageId: string): void {
    this.recalled.add(messageId);
  }

  /** Feishu stops minting tokens for the app, as when its secret is reset. */
  refuseCredential(): void {
    this.credentialRefused = true;
  }

  private route({ method, path, query, headers, body }: PeerRequest): Reply | undefined {
    if (method === "POST" && path === "/open-apis/auth/v3/tenant_access_token/internal")
      return this.token(body);
    if (!path.startsWith(MESSAGES)) return undefined;
    if (headers.get("authorization") !== `Bearer ${TOKEN}`)
      return refusal(
        99991663,
        "Invalid access token for authorization. Please make a request with token attached.",
      );
    const rest = path.slice(MESSAGES.length);
    if (method === "POST" && rest === "") return this.create(query, body);
    const reply = /^\/(om_\w+)\/reply$/.exec(rest);
    if (method === "POST" && reply) return this.reply(reply[1]!, body);
    const update = /^\/(om_\w+)$/.exec(rest);
    if (method === "PUT" && update) return this.update(update[1]!, body);
    return undefined;
  }

  private token(body: Record<string, unknown>): Reply | undefined {
    if (body.app_id !== FEISHU_APP_ID) return undefined;
    // The SDK reads a token from a 200 answer and throws on one without it.
    if (this.credentialRefused)
      return { body: { code: 10014, msg: "app secret invalid" }, source: "synthetic" };
    return {
      body: { code: 0, msg: "ok", tenant_access_token: TOKEN, expire: 7200 },
      source: "synthetic",
    };
  }

  private create(query: URLSearchParams, body: Record<string, unknown>): Reply | undefined {
    const chat = String(body.receive_id);
    if (query.get("receive_id_type") !== "chat_id" || !this.chats.has(chat)) return undefined;
    return this.post(body, (text) =>
      this.store.add({ id: this.messageId(), conversation: chat, from: "rome", text }),
    );
  }

  private reply(targetId: string, body: Record<string, unknown>): Reply | undefined {
    const target = this.store.get(targetId);
    if (!target) return missing(targetId);
    if (this.recalled.has(targetId)) return refusal(230011, "The message was recalled.");
    return this.post(body, (text) => {
      const message = this.store.add({
        id: this.messageId(),
        conversation: target.conversation,
        from: "rome",
        text,
        replyTo: targetId,
      });
      this.parents.set(message.id, targetId);
      // A reply to a message in a thread stays in it. Otherwise it opens a
      // thread on the message it answers, when it asks to.
      let thread = this.threads.get(targetId);
      if (!thread && body.reply_in_thread === true) {
        thread = `omt_${this.nextThreadId++}`;
        this.threads.set(targetId, thread);
        this.roots.set(thread, targetId);
      }
      if (thread) this.threads.set(message.id, thread);
      return message;
    });
  }

  private update(messageId: string, body: Record<string, unknown>): Reply | undefined {
    const message = this.store.get(messageId);
    if (!message) return missing(messageId);
    if (message.from !== "rome")
      return refusal(230071, "The operator is not the sender of the message.");
    if (message.edits >= MAX_EDITS)
      return refusal(230072, "The message has reached the number of times it can be edited.");
    return this.post(body, (text) => this.store.edit(messageId, text), true);
  }

  /** Reads a post and applies it with `apply`, or refuses it as Feishu would. */
  private post(
    body: Record<string, unknown>,
    apply: (text: string) => VisibleMessage,
    edit = false,
  ): Reply | undefined {
    if (body.msg_type !== "post" || typeof body.content !== "string") return undefined;
    if (Buffer.byteLength(body.content) > CONTENT_LIMIT)
      return refusal(230025, "The message content is too long.");
    const read = readPost(body.content);
    if (!read) return undefined;
    const message = apply(read.text);
    const now = String(Date.now());
    const times = this.times.get(message.id);
    this.times.set(message.id, { create_time: times?.create_time ?? now, update_time: now });
    this.contents.set(message.id, read.content);
    return {
      body: { code: 0, data: this.wire(message, edit), msg: "success" },
      source: "capture",
      accepted: true,
    };
  }

  /** A stored message as the API spells it, from the recorded one. */
  private wire(message: VisibleMessage, updated: boolean): Record<string, unknown> {
    const parent = this.parents.get(message.id);
    const thread = this.threads.get(message.id);
    const root = thread ? this.roots.get(thread) : parent && (this.rootOf(parent) ?? parent);
    return {
      ...structuredClone(created),
      body: { content: this.contents.get(message.id) },
      chat_id: message.conversation,
      ...this.times.get(message.id),
      message_id: message.id,
      ...(parent ? { parent_id: parent, root_id: root } : {}),
      ...(thread ? { thread_id: thread } : {}),
      updated,
    };
  }

  private rootOf(messageId: string): string | undefined {
    const parent = this.parents.get(messageId);
    return parent ? (this.rootOf(parent) ?? parent) : undefined;
  }

  private messageId(): string {
    return `om_${this.nextMessageId++}`;
  }
}

// No capture covers these refusals yet. Feishu answers a refused write with a
// 400 and its code.
function refusal(code: number, msg: string): Reply {
  return { status: 400, body: { code, msg }, source: "synthetic" };
}

/** The recorded answer for a message id that does not exist, naming `id`. */
function missing(id: string): Reply {
  const answer = JSON.parse(
    JSON.stringify(exemplar(capture, "missing-message")).replaceAll(MISSING_ID, id),
  ) as unknown;
  return { status: 400, body: answer, source: "capture" };
}

/**
 * The text a post shows, and the content Feishu answers with: each element as
 * a styled run, with `content_v2` keeping a Markdown element as it was sent.
 * Undefined for a post the peer does not model.
 */
function readPost(raw: string): { text: string; content: string } | undefined {
  const post = (JSON.parse(raw) as Record<string, { title?: string; content?: PostElement[][] }>)
    .zh_cn;
  if (!post?.content) return undefined;
  const elements = post.content.flat();
  if (elements.some(({ tag, text }) => !["text", "a", "md"].includes(tag) || text === undefined))
    return undefined;
  const run = ({ tag, href, text }: PostElement) => ({
    tag: tag === "md" ? "text" : tag,
    ...(href !== undefined ? { href } : {}),
    text,
    style: [],
  });
  // A post shows no whitespace at its edges, as Markdown drops a paragraph's.
  const text = post.content
    .map((line) => line.map((element) => element.text).join(""))
    .join("\n")
    .trim();
  if (!text) return undefined;
  const content = JSON.stringify({
    title: post.title ?? "",
    content: post.content.map((line) => line.map(run)),
    content_v2: post.content.map((line) =>
      line.map((element) =>
        element.tag === "md" ? { tag: "md", text: element.text } : run(element),
      ),
    ),
  });
  return { text, content };
}
