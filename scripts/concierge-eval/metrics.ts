// How noisy one Concierge chat was, from its rows in the database: what the
// Concierge said, which turns spoke, and what each turn cost. Pure, so the
// rules are tested apart from a live stack. docs/concierge-eval.md

/** A row of `chat_messages`, with its parts still JSON. */
export interface MessageRow {
  key: string;
  sender_agent: string | null;
  text: string;
  parts: string;
  said_at: number;
  chat_thread_id: string | null;
}

/** A trace row of `rome_agent_messages`: one per Concierge turn. */
export interface TurnRow {
  turn_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens?: number | null;
  created_at: number;
}

export type MessageKind =
  | "say"
  | "forward"
  | "task_card"
  | "ask_card"
  | "own_ask"
  | "connect_card"
  | "other";

export interface ClassifiedMessage {
  key: string;
  at: number;
  kind: MessageKind;
  text: string;
  /** Set on a say or forward that only acknowledges or announces. */
  ack?: boolean;
  /** Set on a say or forward that only restates a card's outcome or the owner's answer. */
  echo?: boolean;
}

/** What the owner did on a card, which a later message may restate. */
export interface CardOutcome {
  at: number;
  /** The picked options, or the decision: approved, rejected, expired. */
  words: string[];
}

export interface ChatMetrics {
  ownerMessages: number;
  conciergeMessages: number;
  perOwnerMessage: number;
  byKind: Record<MessageKind, number>;
  acks: number;
  echoes: number;
  /** Runs of two or more Concierge messages within a minute, with no owner message or card answer between. */
  bursts: number;
  messagesInBursts: number;
  turns: number;
  silentTurns: number;
  inputTokens: { total: number; mean: number };
  cacheReadTokens: { total: number; mean: number };
  outputTokens: { total: number; mean: number };
  /** Every Concierge message, so a flag can be checked by eye. */
  messages: ClassifiedMessage[];
}

const BURST_WINDOW_S = 60;

/** A message that opens with an acknowledgement, or announces what it will do. */
const ACK =
  /^\s*(got it|on it|okay|ok\b|sure\b|noted|understood|will do|alright|i['’]ll\b|i will\b|let me\b|starting\b|i['’]m (on|starting|checking|looking)|好的|收到|明白|了解|我来|我会|马上)/i;

/** Words that name a card's outcome, in a message that restates it. */
const OUTCOME_WORDS =
  /\b(approved|rejected|declined|turned down|expired|no response|not written|was not (written|created|saved)|you (chose|picked|selected|prefer)|it['’]s settled|dismissed|card (is )?closed)|已批准|已拒绝|拒绝了|批准了|过期|没有回应|无人回应|你选|选择了/i;

/** A restatement is short: anything longer is taken to carry news. */
const ECHO_MAX_CHARS = 200;

function parsedParts(row: MessageRow): Record<string, unknown>[] {
  try {
    const parts = JSON.parse(row.parts) as unknown;
    return Array.isArray(parts) ? (parts as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

export function kindOf(row: MessageRow): MessageKind {
  const parts = parsedParts(row);
  const types = new Set(parts.map((p) => p.type));
  const taskChat = parts.find((p) => p.type === "task_chat");
  if (taskChat) return taskChat.show === "ask" ? "ask_card" : "task_card";
  if (types.has("pending_interaction")) return "own_ask";
  if (types.has("connect_card")) return "connect_card";
  const text = parts.find((p) => p.type === "text");
  if (text?.forwardedFrom) return "forward";
  if (text || row.text.trim()) return "say";
  return "other";
}

/** Whether a message comes from the owner: typed by them, not a card's answer. */
export function isOwnerMessage(row: MessageRow): boolean {
  if (row.sender_agent) return false;
  const parts = parsedParts(row);
  if (parts.length > 0 && parts.every((p) => p.type === "interaction_result")) return false;
  return row.text.trim() !== "" || parts.some((p) => p.type === "text");
}

/**
 * Whether `text`, said after `outcome`, only restates it: short, and naming
 * the picked option or the decision. `result` is what the scenario expects
 * as real news; a message that carries it is never an echo.
 */
export function isEcho(text: string, outcome: CardOutcome, result?: RegExp[]): boolean {
  if (text.length > ECHO_MAX_CHARS) return false;
  if (result?.some((r) => r.test(text))) return false;
  const lower = text.toLowerCase();
  const namesPick = outcome.words.some((w) => w && lower.includes(w.toLowerCase()));
  return namesPick || OUTCOME_WORDS.test(text);
}

export function isAck(text: string): boolean {
  return ACK.test(text);
}

/**
 * The expected results no message carries. Only real content counts: a
 * message that acknowledges or announces the work never carries its result,
 * whatever it names.
 */
export function resultsMissing(texts: string[], expected: RegExp[]): RegExp[] {
  const results = texts.filter((t) => !isAck(t));
  return expected.filter((r) => !results.some((t) => r.test(t)));
}

export interface MetricsInput {
  messages: MessageRow[];
  turns: TurnRow[];
  /** Turns that sent at least one message. */
  speakingTurns: Set<string>;
  /** The owner's card answers and decisions, in time order. */
  outcomes: CardOutcome[];
  /** Real news the scenario expects, which an echo never carries. */
  result?: RegExp[];
}

export function chatMetrics(input: MetricsInput): ChatMetrics {
  const rows = [...input.messages].sort((a, b) => a.said_at - b.said_at);
  const byKind: Record<MessageKind, number> = {
    say: 0,
    forward: 0,
    task_card: 0,
    ask_card: 0,
    own_ask: 0,
    connect_card: 0,
    other: 0,
  };
  const classified: ClassifiedMessage[] = [];
  let ownerMessages = 0;
  let lastOwnerAt = -Infinity;
  // Bursts: consecutive Concierge messages, each within a minute of the one
  // before, with no owner message between.
  let run = 0;
  let prevAt = -Infinity;
  let bursts = 0;
  let messagesInBursts = 0;
  const closeRun = () => {
    if (run >= 2) {
      bursts += 1;
      messagesInBursts += run;
    }
    run = 0;
  };

  for (const row of rows) {
    if (isOwnerMessage(row)) {
      ownerMessages += 1;
      lastOwnerAt = row.said_at;
      closeRun();
      continue;
    }
    if (!row.sender_agent) continue;
    const kind = kindOf(row);
    byKind[kind] += 1;
    const message: ClassifiedMessage = { key: row.key, at: row.said_at, kind, text: row.text };
    if (kind === "say" || kind === "forward") {
      message.ack = isAck(row.text);
      // The outcome it may restate: the latest card settled after the
      // owner's last message and before this one.
      const outcome = [...input.outcomes]
        .reverse()
        .find((o) => o.at <= row.said_at && o.at >= lastOwnerAt);
      message.echo = outcome ? isEcho(row.text, outcome, input.result) : false;
    }
    classified.push(message);
    // The owner's card answer goes to the task chat, not this one, yet it
    // is the owner speaking: the message after it starts a new run.
    const answeredBetween = input.outcomes.some((o) => o.at > prevAt && o.at <= row.said_at);
    if (row.said_at - prevAt <= BURST_WINDOW_S && run > 0 && !answeredBetween) run += 1;
    else {
      closeRun();
      run = 1;
    }
    prevAt = row.said_at;
  }
  closeRun();

  const conciergeMessages = classified.length;
  const sum = (f: (t: TurnRow) => number | null) =>
    input.turns.reduce((n, t) => n + (f(t) ?? 0), 0);
  const stat = (f: (t: TurnRow) => number | null) => {
    const total = sum(f);
    return { total, mean: input.turns.length ? Math.round(total / input.turns.length) : 0 };
  };
  return {
    ownerMessages,
    conciergeMessages,
    perOwnerMessage: ownerMessages ? round2(conciergeMessages / ownerMessages) : conciergeMessages,
    byKind,
    acks: classified.filter((m) => m.ack).length,
    echoes: classified.filter((m) => m.echo).length,
    bursts,
    messagesInBursts,
    turns: input.turns.length,
    silentTurns: input.turns.filter((t) => !input.speakingTurns.has(t.turn_id)).length,
    // The whole prompt: Anthropic reports the cached part apart from the
    // input. OpenAI counts it in the input, so compare one provider only.
    inputTokens: stat(
      (t) => (t.input_tokens ?? 0) + (t.cache_read_tokens ?? 0) + (t.cache_write_tokens ?? 0),
    ),
    cacheReadTokens: stat((t) => t.cache_read_tokens),
    outputTokens: stat((t) => t.output_tokens),
    messages: classified,
  };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
