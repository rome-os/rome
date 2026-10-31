import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A loopback stand-in for WeChat's iLink bot API, for the browser suite. Rome's
// own iLink adapter calls the global fetch, and the launcher routes the iLink
// origin here, so the connection setup, the long poll and the sends run the
// code that ships. The QR login confirms on its first status poll, as if the
// guardian had scanned and confirmed at once.
//
// The unit-level peer in ../kit/im/wechat.ts replays recorded answers; this
// one only has to keep a real Rome talking, so it models the few calls a
// connect, an inbound message and a reply make.

const ILINK_ORIGIN = "https://ilinkai.weixin.qq.com";
const ILINK_BOT_TOKEN = "e2e-bot-token";
const ILINK_BOT_ID = "e2e-bot@im.bot";
/** The guardian's own WeChat user: the login binds it, so Rome answers it. */
const ILINK_GUARDIAN = "e2e-guardian@im.wechat";

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_TEXT = 1;

export interface IlinkMessage {
  id: string;
  from: string;
  to: string;
  text: string;
}

interface WireItem {
  type?: number;
  text_item?: { text?: string };
}

export class FakeIlink {
  /** Every text message, both ways, in order. */
  readonly messages: IlinkMessage[] = [];
  readonly unhandled: string[] = [];
  private readonly updates: Record<string, unknown>[] = [];
  private readonly wake = new Set<() => void>();
  private nextId = 7_000_000;
  private readonly server: Server = createServer((req, res) => {
    void this.handle(req, res).catch((error: unknown) => {
      this.unhandled.push(`error ${req.method} ${req.url}: ${String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  close(): Promise<void> {
    for (const wake of [...this.wake]) wake();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Wraps a fetch so the iLink origin reaches this server and every other
   *  origin goes where it went before. */
  route(original: typeof fetch): typeof fetch {
    return (input, init) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = new URL(raw);
      if (url.origin !== ILINK_ORIGIN) return original(input, init);
      const local = `${this.url}${url.pathname}${url.search}`;
      return original(input instanceof Request ? new Request(local, input) : local, init);
    };
  }

  /** A user writes to the bot; the adapter receives it on its next poll. */
  emitMessage(text: string, from = ILINK_GUARDIAN): IlinkMessage {
    const message = { id: String(this.nextId++), from, to: ILINK_BOT_ID, text };
    this.messages.push(message);
    this.updates.push({
      message_id: Number(message.id),
      from_user_id: from,
      to_user_id: ILINK_BOT_ID,
      message_type: MSG_TYPE_USER,
      message_state: MSG_STATE_FINISH,
      create_time_ms: Date.now(),
      context_token: `context-${from}`,
      item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
    });
    for (const wake of [...this.wake]) wake();
    return message;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/ilink/bot/get_bot_qrcode") {
      return json({ qrcode: "e2e-qrcode", qrcode_img_content: "https://example.invalid/e2e-qr" });
    }
    if (req.method === "GET" && url.pathname === "/ilink/bot/get_qrcode_status") {
      return json({
        status: "confirmed",
        bot_token: ILINK_BOT_TOKEN,
        ilink_bot_id: ILINK_BOT_ID,
        baseurl: ILINK_ORIGIN,
        ilink_user_id: ILINK_GUARDIAN,
      });
    }

    if (req.method !== "POST") {
      this.unhandled.push(`${req.method} ${url.pathname}`);
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${ILINK_BOT_TOKEN}`) {
      this.unhandled.push(`unauthorized POST ${url.pathname}`);
      res.writeHead(401).end();
      return;
    }
    const body = await readJson(req);
    switch (url.pathname) {
      case "/ilink/bot/getupdates":
        return json(await this.getUpdates(body.get_updates_buf, res));
      case "/ilink/bot/getconfig":
        return json({ ret: 0, typing_ticket: "e2e-typing" });
      case "/ilink/bot/sendtyping":
        return json({ ret: 0 });
      case "/ilink/bot/sendmessage":
        return json(this.sendMessage(body.msg as Record<string, unknown> | undefined));
      default:
        this.unhandled.push(`POST ${url.pathname}`);
        res.writeHead(404).end();
    }
  }

  private async getUpdates(cursor: unknown, res: ServerResponse) {
    const from = Number(cursor) || 0;
    if (this.updates.length <= from) {
      // Hold the long poll until a message arrives, the client gives up, or
      // a short timeout passes (the adapter's own timeout is 35 s).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, 10_000);
        function finish() {
          clearTimeout(timer);
          resolve();
        }
        const wake = () => {
          this.wake.delete(wake);
          finish();
        };
        this.wake.add(wake);
        res.once("close", wake);
      });
    }
    return { ret: 0, msgs: this.updates.slice(from), get_updates_buf: String(this.updates.length) };
  }

  private sendMessage(msg: Record<string, unknown> | undefined) {
    const items = (msg?.item_list as WireItem[] | undefined) ?? [];
    const text = items.map((item) => item.text_item?.text ?? "").join("");
    const message = {
      id: String(this.nextId++),
      from: ILINK_BOT_ID,
      to: String(msg?.to_user_id ?? ""),
      text,
    };
    if (msg?.message_type !== MSG_TYPE_BOT) this.unhandled.push("sendmessage without a bot type");
    this.messages.push(message);
    return { ret: 0, message_id: Number(message.id) };
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
