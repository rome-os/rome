import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import {
  DeliveryFailure,
  type DeliveryTransport,
  type PartReceipt,
  type TextCodec,
} from "../types.js";
import { neverConnected } from "./network.js";

/** Feishu lets a message be edited this many times. */
export const FEISHU_MAX_EDITS = 20;
/** Messages whose edits are counted, oldest dropped first. A dropped message's
 *  count starts again, and Feishu's own refusal then stops its edits. */
const TRACKED_MESSAGES = 1000;
/** Marks a conversation as a thread, which later messages of a reply join. */
const THREAD = "#thread:";

/** Feishu's answer to a write, as the SDK's client resolves it. */
interface Answer {
  code?: number;
  msg?: string;
  data?: { message_id?: string; chat_id?: string; root_id?: string; thread_id?: string };
}

/** A refusal Feishu answered with HTTP 200 and a nonzero code. */
class FeishuRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FeishuTransportOptions {
  client: LarkChannel["rawClient"];
  /** Whether a reply to a message in `chat` opens a thread there, as the chat's
   *  settings say. A whole reply is placed the same way. */
  replyInThread(chat: string): Promise<boolean>;
}

/**
 * Reply delivery over Feishu's message API. Each message is a rich-text post
 * holding one Markdown element, which is what the SDK's `send` makes of a
 * whole reply, so a streamed reply looks the same. The writes go to the API
 * directly: the SDK's `send` repeats a failed create on its own and falls back
 * to plain text, which would hide what happened from the reply.
 *
 * Feishu lets a message be edited 20 times. The capabilities say so, and the
 * transport also counts the edits and refuses the next as `unsupported`
 * without asking Feishu.
 */
export function feishuTransport({
  client,
  replyInThread,
}: FeishuTransportOptions): DeliveryTransport {
  const edits = new Map<string, number>();
  const count = (messageId: string, used: number) => {
    edits.delete(messageId);
    edits.set(messageId, used);
    if (edits.size > TRACKED_MESSAGES) edits.delete(edits.keys().next().value!);
  };

  const reply = async (to: string, content: string, inThread: boolean) =>
    answered(
      await client.im.v1.message.reply({
        path: { message_id: to },
        data: { msg_type: "post", content, reply_in_thread: inThread },
      }),
    );

  return {
    capabilities: {
      // The SDK sends a whole reply in posts of up to 3500 characters.
      maxPartLength: 3500,
      edit: true,
      maxEditsPerMessage: FEISHU_MAX_EDITS,
      // Feishu allows an app 50 writes a second and 1000 a minute, and 5 a
      // second to one user or one group, which the group's bots share.
      budget: { burst: 50, refillMs: 60, conversationSpacingMs: 200 },
    },
    codec: feishuMarkdown,
    create: (conversation, text, replyTo) =>
      call(async () => {
        const { chat, root } = placeOf(conversation);
        const content = postOf(text);
        // A message that answers the user's goes where the chat's settings put
        // replies. Later messages of the reply follow the first into its thread.
        const target = replyTo ?? root;
        if (target) {
          let inThread = root !== undefined;
          if (!inThread) {
            try {
              inThread = await replyInThread(chat);
            } catch (error) {
              throw new DeliveryFailure("unavailable", messageOf(error));
            }
          }
          try {
            return receiptOf(chat, await reply(target, content, inThread));
          } catch (error) {
            // The user can recall or delete the message while a long run
            // streams. The reply is still worth sending, without the link to it.
            if (!REPLY_TARGET_GONE.has(codeOf(error) ?? 0)) throw error;
          }
        }
        const created = answered(
          await client.im.v1.message.create({
            params: { receive_id_type: receiveIdTypeOf(chat) },
            data: { receive_id: chat, msg_type: "post", content },
          }),
        );
        return receiptOf(chat, created);
      }),
    edit: async (receipt, text) => {
      const used = edits.get(receipt.messageId) ?? 0;
      if (used >= FEISHU_MAX_EDITS)
        throw new DeliveryFailure(
          "unsupported",
          `Feishu allows a message ${FEISHU_MAX_EDITS} edits, and this one has had them`,
        );
      count(receipt.messageId, used + 1);
      try {
        await call(async () =>
          answered(
            await client.im.v1.message.update({
              path: { message_id: receipt.messageId },
              data: { msg_type: "post", content: postOf(text) },
            }),
          ),
        );
      } catch (error) {
        // Only an edit that may have arrived counts against the message.
        if (error instanceof DeliveryFailure && error.kind !== "unknown")
          count(receipt.messageId, used);
        throw error;
      }
    },
  };
}

/**
 * Markdown as the SDK's `send` prepares it for a post (`markdownToPost` in
 * `@larksuiteoapi/node-sdk`): headings come down to H4 and H5 when the text has
 * a large one, since Feishu shows H1 to H3 very large, and runs of blank lines
 * shrink to one. Fenced code is left alone. A preview is rendered the same way.
 * The measure counts UTF-16 code units, as the SDK's split does.
 *
 * Code that runs past the end of a message is closed there and opened again
 * at the start of the next, as the SDK's split does, so each message shows it
 * as code.
 */
export const feishuMarkdown: TextCodec = {
  render: (source, _settled, context) => {
    const open = fenceAfter(context?.before ?? "");
    const lines = `${open ? `${open.line}\n` : ""}${source}`.split("\n");
    const code: string[] = [];
    const prose: string[] = [];
    let fence: Fence | undefined;
    let block: string[] = [];
    for (const line of lines) {
      if (fence) {
        block.push(line);
        if (closes(line, fence)) {
          prose.push(placeholder(code, block.join("\n")));
          fence = undefined;
        }
        continue;
      }
      fence = opener(line);
      if (fence) block = [line];
      else prose.push(line);
    }
    if (fence) {
      // A trailing newline in the code would show as a blank last line, and a
      // closing fence that has begun to arrive is finished rather than shown
      // as code, so the rendering never shrinks as the source grows.
      const last = block.at(-1)!;
      if (block.length > 1 && (last === "" || new RegExp(`^ {0,3}\\${fence.char}+$`).test(last)))
        block.pop();
      block.push(fence.char.repeat(fence.length));
      prose.push(placeholder(code, block.join("\n")));
    }

    let text = prose.join("\n");
    // The SDK looks for a large heading in the text as given, fences included.
    if (/^#{1,3} /m.test(source))
      text = text.replace(/^#{2,6} (.+)$/gm, "##### $1").replace(/^# (.+)$/gm, "#### $1");
    return text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)]!);
  },
  measure: (rendered) => rendered.length,
};

/** An open code fence: its opening line, and what a closing line must repeat. */
interface Fence {
  line: string;
  char: string;
  length: number;
}

function opener(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return undefined;
  return { line, char: match[1]![0]!, length: match[1]!.length };
}

function closes(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1]![0] === fence.char && match[1]!.length >= fence.length;
}

/** The fence still open at the end of `text`, if any. */
function fenceAfter(text: string): Fence | undefined {
  let fence: Fence | undefined;
  for (const line of text.split("\n")) {
    if (!fence) fence = opener(line);
    else if (closes(line, fence)) fence = undefined;
  }
  return fence;
}

/** Stores `block` in `code` and answers the token that stands for it. */
function placeholder(code: string[], block: string): string {
  code.push(block);
  return `\u0000${code.length - 1}\u0000`;
}

/** A post that shows `text` as Markdown. */
function postOf(text: string): string {
  return JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "md", text }]] } });
}

/** Where a conversation's next message goes: the chat, and the root of the
 *  thread a reply opened there. */
function placeOf(conversation: string): { chat: string; root?: string } {
  const at = conversation.indexOf(THREAD);
  if (at < 0) return { chat: conversation };
  return { chat: conversation.slice(0, at), root: conversation.slice(at + THREAD.length) };
}

function receiptOf(chat: string, answer: Answer): PartReceipt {
  const { message_id, chat_id, root_id, thread_id } = answer.data ?? {};
  // Feishu took the message, but its id is missing, so the reply cannot name it.
  if (!message_id) throw new DeliveryFailure("unknown", "Feishu answered without a message id");
  const at = chat_id ?? chat;
  return {
    messageId: message_id,
    chatId: thread_id && root_id ? `${at}${THREAD}${root_id}` : at,
  };
}

/** The id type Feishu needs for `to`, read off its prefix as the SDK reads it. */
function receiveIdTypeOf(to: string): "chat_id" | "open_id" | "union_id" | "email" | "user_id" {
  if (to.startsWith("oc_")) return "chat_id";
  if (to.startsWith("ou_")) return "open_id";
  if (to.startsWith("on_")) return "union_id";
  return to.includes("@") ? "email" : "user_id";
}

/** The answer, or Feishu's refusal when it answered 200 with a nonzero code. */
function answered(answer: Answer): Answer {
  if (answer.code !== undefined && answer.code !== 0)
    throw new FeishuRefusal(answer.code, answer.msg ?? `Feishu refused with code ${answer.code}`);
  return answer;
}

async function call<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw classify(error);
  }
}

// Codes from Feishu's API references for sending, replying to and editing
// messages, and from its generic error codes.
const RATE_LIMITED = new Set([230020, 99991400]);
/** The app's credential no longer mints a token Feishu accepts. */
const UNAUTHORIZED = new Set([10003, 99991661, 99991663, 99991664, 99991668, 99991679]);
/** Feishu will not edit this message: it has had its 20 edits, its editing
 *  window is over (which an administrator sets), it is in an encrypted group,
 *  or its type cannot be edited. */
const WONT_EDIT = new Set([230054, 230072, 230073, 230074, 230075]);
/** The message a reply answers is recalled or deleted. */
const REPLY_TARGET_GONE = new Set([230011, 230110]);

interface HttpFailure {
  config?: { url?: unknown };
  response?: { status?: number; data?: { code?: unknown; msg?: unknown }; headers?: unknown };
}

function codeOf(error: unknown): number | undefined {
  if (error instanceof FeishuRefusal) return error.code;
  const code = (error as HttpFailure | null)?.response?.data?.code;
  return typeof code === "number" ? code : undefined;
}

/** How long Feishu asked to wait, from its rate-limit header in seconds. */
function retryAfterMs(error: unknown): number {
  const headers = (error as HttpFailure | null)?.response?.headers as
    | Record<string, unknown>
    | undefined;
  const seconds = Number(headers?.["x-ogw-ratelimit-reset"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
}

function classify(error: unknown): DeliveryFailure {
  if (error instanceof DeliveryFailure) return error;
  const message = messageOf(error);
  const code = codeOf(error);
  const status = (error as HttpFailure | null)?.response?.status;
  if ((code !== undefined && RATE_LIMITED.has(code)) || status === 429)
    return new DeliveryFailure("rate-limited", message, retryAfterMs(error));
  if (code !== undefined && UNAUTHORIZED.has(code))
    return new DeliveryFailure("unauthorized", message);
  if (code !== undefined && WONT_EDIT.has(code)) return new DeliveryFailure("unsupported", message);
  // The SDK mints a token before the write, and throws this when Feishu refuses
  // the app's credential. The write was never sent.
  if (/^failed to get tenant_access_token\b/.test(message))
    return new DeliveryFailure("unauthorized", message);
  const url = (error as HttpFailure | null)?.config?.url;
  // A failed token request precedes the message write, so the message is safe to retry.
  if (
    (status === undefined || status >= 500) &&
    typeof url === "string" &&
    URL.canParse(url) &&
    new URL(url).pathname === "/open-apis/auth/v3/tenant_access_token/internal"
  )
    return new DeliveryFailure("unavailable", message);
  // A server error is a hiccup, and the write may have gone through before it.
  if (status !== undefined && status >= 500) return new DeliveryFailure("unknown", message);
  // Feishu answered and refused. It will refuse the same write again.
  if (code !== undefined || status !== undefined) return new DeliveryFailure("rejected", message);
  // A connection that never opened did not carry the request, so it may be
  // sent again. Any other failure may have come after the request was written.
  if (neverConnected(error)) return new DeliveryFailure("unavailable", message);
  return new DeliveryFailure("unknown", message);
}

function messageOf(error: unknown): string {
  const msg = (error as HttpFailure | null)?.response?.data?.msg;
  if (typeof msg === "string" && msg) return msg;
  return error instanceof Error ? error.message : String(error);
}
