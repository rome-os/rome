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
const CARDS = "/open-apis/cardkit/v1/cards";
/** Feishu refuses a post or card whose content is larger than this. */
const CONTENT_LIMIT = 30 * 1024;
const MAX_EDITS = 20;

interface PostElement {
  tag: string;
  text?: string;
  href?: string;
}

/** A CardKit card entity, holding one Markdown element. */
export interface PeerCard {
  element: string;
  text: string;
  /** The card shows its text as it is typed, and takes streamed text. */
  streaming: boolean;
  /** What the chat list shows for the card's message. */
  summary?: string;
  /** The last sequence number a write to the card carried. */
  sequence: number;
  /** The message that shows the card, once one was sent. */
  messageId?: string;
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
 *
 * CardKit's cards are modelled as the API reference describes them, and answer
 * with `source: "synthetic"`: a card in streaming mode takes its element's
 * text and its settings, each write with a sequence number above the last.
 * A message that shows a card shows its element's text, and a write to the
 * text counts as an edit of the message.
 */
export class FeishuPeer implements Peer {
  readonly server = new PeerServer((request) => this.route(request));
  private readonly store = new MessageStore();
  private readonly cards = new Map<string, PeerCard>();
  private nextCardId = 1;
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

  /** The card a message shows, if it shows one. */
  cardOf(messageId: string): PeerCard | undefined {
    for (const card of this.cards.values()) if (card.messageId === messageId) return { ...card };
    return undefined;
  }

  /** Every card created, sent or not. */
  allCards(): PeerCard[] {
    return [...this.cards.values()].map((card) => ({ ...card }));
  }

  /** Feishu ends a card's streaming mode, as it does ten minutes after it began. */
  endStreaming(messageId: string): void {
    for (const card of this.cards.values())
      if (card.messageId === messageId) card.streaming = false;
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
    if (!path.startsWith(MESSAGES) && !path.startsWith(CARDS)) return undefined;
    if (headers.get("authorization") !== `Bearer ${TOKEN}`)
      return refusal(
        99991663,
        "Invalid access token for authorization. Please make a request with token attached.",
      );
    if (path.startsWith(CARDS)) return this.card(method, path.slice(CARDS.length), body);
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
    if (body.msg_type === "interactive" && !edit) return this.cardMessage(body, apply);
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

  /** Sends a message that shows a card the app created, which shows its text. */
  private cardMessage(
    body: Record<string, unknown>,
    apply: (text: string) => VisibleMessage,
  ): Reply | undefined {
    if (typeof body.content !== "string") return undefined;
    const content = JSON.parse(body.content) as { type?: string; data?: { card_id?: string } };
    const card = this.cards.get(content.data?.card_id ?? "");
    if (content.type !== "card" || !card || card.messageId) return undefined;
    const message = apply(card.text.trim());
    card.messageId = message.id;
    const now = String(Date.now());
    this.times.set(message.id, { create_time: now, update_time: now });
    this.contents.set(message.id, body.content);
    return {
      body: { code: 0, data: this.wire(message, false), msg: "success" },
      source: "synthetic",
      accepted: true,
    };
  }

  private card(method: string, rest: string, body: Record<string, unknown>): Reply | undefined {
    if (method === "POST" && rest === "") return this.createCard(body);
    const content = /^\/(\w+)\/elements\/(\w+)\/content$/.exec(rest);
    if (method === "PUT" && content) return this.streamText(content[1]!, content[2]!, body);
    const settings = /^\/(\w+)\/settings$/.exec(rest);
    if (method === "PATCH" && settings) return this.cardSettings(settings[1]!, body);
    const whole = /^\/(\w+)$/.exec(rest);
    if (method === "PUT" && whole) return this.replaceCard(whole[1]!, body);
    return undefined;
  }

  private createCard(body: Record<string, unknown>): Reply | undefined {
    const json = this.cardJson(body);
    if (!json || "body" in json) return json;
    const id = `7${String(this.nextCardId++).padStart(18, "0")}`;
    this.cards.set(id, { ...json, sequence: 0 });
    return { body: { code: 0, msg: "success", data: { card_id: id } }, source: "synthetic" };
  }

  /** What a card JSON body this peer models makes of a card, or Feishu's
   *  refusal of it. */
  private cardJson(
    body: Record<string, unknown>,
  ): Pick<PeerCard, "element" | "text" | "streaming" | "summary"> | Reply | undefined {
    if (body.type !== "card_json" || typeof body.data !== "string") return undefined;
    if (Buffer.byteLength(body.data) > CONTENT_LIMIT)
      return refusal(200860, "Card content exceeds limit.");
    const json = JSON.parse(body.data) as {
      schema?: string;
      config?: { streaming_mode?: boolean; summary?: { content?: string } };
      body?: { elements?: Array<{ tag?: string; element_id?: string; content?: string }> };
    };
    const elements = json.body?.elements ?? [];
    const [element] = elements;
    if (
      json.schema !== "2.0" ||
      elements.length !== 1 ||
      element?.tag !== "markdown" ||
      !element.element_id ||
      typeof element.content !== "string"
    )
      return undefined;
    const summary = json.config?.summary?.content;
    return {
      element: element.element_id,
      text: element.content,
      streaming: json.config?.streaming_mode === true,
      ...(summary !== undefined ? { summary } : {}),
    };
  }

  /** The card's write with `sequence`, or Feishu's refusal of it. */
  private cardWrite(id: string, sequence: unknown): PeerCard | Reply {
    const card = this.cards.get(id);
    if (!card) return refusal(200740, "The card entity does not exist.");
    if (typeof sequence !== "number" || sequence <= card.sequence)
      return refusal(300317, "The sequence number for operating on the card did not increment.");
    card.sequence = sequence;
    return card;
  }

  private streamText(
    id: string,
    element: string,
    body: Record<string, unknown>,
  ): Reply | undefined {
    if (typeof body.content !== "string") return undefined;
    const card = this.cardWrite(id, body.sequence);
    if ("body" in card) return card;
    if (element !== card.element) return undefined;
    if (!card.streaming) return refusal(300309, "Card streaming closed.");
    card.text = body.content;
    if (card.messageId) this.store.edit(card.messageId, body.content.trim());
    return { body: { code: 0, msg: "success", data: {} }, source: "synthetic", accepted: true };
  }

  /** Replaces the whole card, which Feishu allows in or out of streaming mode. */
  private replaceCard(id: string, body: Record<string, unknown>): Reply | undefined {
    const json = this.cardJson((body.card ?? {}) as Record<string, unknown>);
    if (!json || "body" in json) return json;
    const card = this.cardWrite(id, body.sequence);
    if ("body" in card) return card;
    delete card.summary;
    Object.assign(card, json);
    if (card.messageId) this.store.edit(card.messageId, card.text.trim());
    return { body: { code: 0, msg: "success", data: {} }, source: "synthetic", accepted: true };
  }

  private cardSettings(id: string, body: Record<string, unknown>): Reply | undefined {
    if (typeof body.settings !== "string") return undefined;
    const card = this.cardWrite(id, body.sequence);
    if ("body" in card) return card;
    const { config } = JSON.parse(body.settings) as {
      config?: { streaming_mode?: boolean; summary?: { content?: string } };
    };
    if (config?.streaming_mode !== undefined) card.streaming = config.streaming_mode;
    if (config?.summary?.content !== undefined) card.summary = config.summary.content;
    return { body: { code: 0, msg: "success", data: {} }, source: "synthetic" };
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
