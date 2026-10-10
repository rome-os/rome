import type { ReplyOutcome } from "../../../channels/delivery/reply.js";
import type { Peer } from "./peer.js";
import type { TraceCheck } from "./trace.js";

/** What a delivered reply is checked against. */
export interface DeliveryCheck {
  /** The reply's full text: every block, in order. */
  source: string;
  outcome: ReplyOutcome;
  peer: Pick<Peer, "visible" | "changes">;
  conversation: string;
  /** The most a message may hold, in the characters the peer counts. */
  maxPartLength: number;
  /**
   * The agent's complete text differs from what streamed, so a message may
   * correctly go back, as when it is edited to put right an edit whose answer
   * was lost. The rules that assume the stream is the final text leave the
   * reply out.
   */
  revised?: boolean;
}

type Rule = { id: string; check(input: DeliveryCheck): string | undefined };

/**
 * Rules a delivered reply keeps, read off what the platform shows rather than
 * what the engine believes. Each has a stable id, so a failure names the rule
 * it broke. A platform may trim the whitespace at a message's edges, so a rule
 * that compares text tolerates exactly that and nothing else.
 */
const RULES: Rule[] = [
  {
    id: "final-text-is-the-reply",
    check: ({ source, outcome, peer, conversation }) => {
      // A reply that reports itself as differing is not held to its final text.
      if (outcome.status !== "delivered" || outcome.diverged) return undefined;
      const shown = romeMessages(peer, conversation).map((message) => message.text);
      return tiles(source, shown)
        ? undefined
        : `shows ${quote(shown.join(""))}, the reply is ${quote(source)}`;
    },
  },
  {
    // A create with an unknown result may or may not show, but never twice.
    id: "one-message-per-part",
    check: ({ outcome, peer, conversation }) => {
      const shown = romeMessages(peer, conversation).length;
      const accepted = outcome.parts.filter((part) => part.receipt).length;
      const unknown = outcome.parts.filter((part) => part.state === "unknown").length;
      return shown >= accepted && shown <= accepted + unknown
        ? undefined
        : `${shown} messages for ${accepted} accepted and ${unknown} unknown parts`;
    },
  },
  {
    id: "receipts-name-what-is-shown",
    check: ({ outcome, peer, conversation }) => {
      const shown = new Map(romeMessages(peer, conversation).map((m) => [m.id, m.text.trim()]));
      const wrong = outcome.parts.filter(
        (part) => part.receipt && shown.get(part.receipt.messageId) !== part.text.trim(),
      );
      return wrong.length
        ? `receipts ${wrong.map((part) => part.receipt?.messageId).join(", ")} do not match the platform`
        : undefined;
    },
  },
  {
    id: "every-message-fits",
    check: ({ peer, conversation, maxPartLength }) => {
      const long = romeMessages(peer, conversation).filter((m) => m.text.length > maxPartLength);
      return long.length ? `${long.length} messages exceed ${maxPartLength} characters` : undefined;
    },
  },
  {
    // Holds for a codec whose preview is a prefix of its settled text, as plain
    // text is, and for a reply whose complete text is what streamed. A reply
    // that revised the stream can put a message back, so its caller sets
    // `revised` and the rule leaves it out.
    id: "text-never-goes-back",
    check: ({ peer, conversation, revised }) => {
      if (revised) return undefined;
      const texts = new Map<string, string[]>();
      for (const { message } of peer.changes(conversation)) {
        if (message.from !== "rome") continue;
        texts.set(message.id, [...(texts.get(message.id) ?? []), message.text]);
      }
      for (const [id, history] of texts) {
        const back = history.findIndex(
          (text, i) => i > 0 && !text.startsWith(history[i - 1] ?? ""),
        );
        if (back > 0)
          return `message ${id} went from ${quote(history[back - 1] ?? "")} to ${quote(history[back] ?? "")}`;
      }
      return undefined;
    },
  },
];

/** Runs every rule against a delivered reply. */
export function checkDelivery(input: DeliveryCheck): TraceCheck[] {
  return RULES.map(({ id, check }) => {
    const detail = check(input);
    return detail === undefined ? { id, ok: true } : { id, ok: false, detail };
  });
}

function romeMessages(peer: DeliveryCheck["peer"], conversation: string) {
  return peer.visible(conversation).filter((message) => message.from === "rome");
}

/** The messages, in order, make up `source`, apart from whitespace at their edges. */
function tiles(source: string, messages: string[]): boolean {
  const skipSpace = (from: number) => {
    let at = from;
    while (at < source.length && /\s/.test(source[at] ?? "")) at += 1;
    return at;
  };
  let at = 0;
  for (const text of messages) {
    at = skipSpace(at);
    if (!source.startsWith(text, at)) return false;
    at += text.length;
  }
  return skipSpace(at) === source.length;
}

function quote(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text);
}
