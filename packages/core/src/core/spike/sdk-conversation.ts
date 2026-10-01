import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../../types.js";
import type { ModelSession } from "../agent-runner.js";
import type { SdkTurnEvent } from "../sdk-turn-projection.js";

// SPIKE (t-8e1a6e90, do not merge): what AgentSession would hold if Rome's
// turns followed the SDK's turns.
//
// State: one map of waiting callers (send id -> caller) and the SDK turn now
// streaming. Sends are fire-and-forget. A turn opens when the SDK starts one,
// answers the sends the SDK echoes, and closes on its result. A turn that
// answers nothing (a background task's turn) is still a turn, for the
// conversation. An echo nobody waits for is ignored with a warning; callers
// still waiting when the stream ends fail with a warning.

export interface CardRecord {
  turnId: string;
  answering: string[];
  tool: string;
}

export interface SubmitRecord {
  turnId: string | undefined;
  answering: string[];
  payload: unknown;
}

export interface TurnRecord {
  turnId: string;
  startedBy: string;
  answers: string[];
  startedAt: number;
  endedAt?: number;
  subtype?: string;
  text: string;
  tools: string[];
  cards: CardRecord[];
  submits: SubmitRecord[];
  terminal?: { type: string; content?: string; error?: string };
}

export interface Reply {
  sendId: string;
  turnId: string;
  /** Turn ids that answered this send (must be exactly one). */
  answeredBy: string[];
  text: string;
  terminal?: { type: string; content?: string; error?: string };
  sentAt: number;
  /** Time from send to the first frame of the turn that answered it. */
  firstFrameMs?: number;
  totalMs: number;
}

interface Waiting {
  sendId: string;
  label: string;
  sentAt: number;
  turnId?: string;
  firstFrameAt?: number;
  answeredBy: string[];
  resolve(reply: Reply): void;
  reject(error: Error): void;
}

export class SdkConversation {
  readonly turns: TurnRecord[] = [];
  readonly warnings: string[] = [];
  readonly log: string[] = [];
  private readonly waiting = new Map<string, Waiting>();
  private readonly labels = new Map<string, string>();
  private current: TurnRecord | undefined;
  private idleWaiters: Array<() => void> = [];
  private readonly t0 = Date.now();
  private ended = false;
  readonly done: Promise<void>;

  constructor(private readonly session: ModelSession) {
    this.done = this.pump();
  }

  /** Label for a send id in logs. */
  name(id: string): string {
    return this.labels.get(id) ?? (id.length > 8 ? id.slice(0, 8) : id);
  }

  private note(line: string): void {
    this.log.push(`${String(Date.now() - this.t0).padStart(6)} ${line}`);
  }

  get idle(): boolean {
    return !this.current && this.waiting.size === 0;
  }

  /** The SDK turn now streaming, for tool calls (cards, submit_output). */
  get currentTurn(): TurnRecord | undefined {
    return this.current;
  }

  /**
   * Send a message. `exclusive` waits until the conversation is idle first,
   * as summon/API callers would, so their reply is theirs alone.
   */
  async send(label: string, text: string, opts: { exclusive?: boolean } = {}): Promise<Reply> {
    if (opts.exclusive) await this.whenIdle();
    const sendId = randomUUID();
    this.labels.set(sendId, label);
    const sentAt = Date.now();
    const reply = new Promise<Reply>((resolve, reject) => {
      this.waiting.set(sendId, { sendId, label, sentAt, answeredBy: [], resolve, reject });
    });
    this.note(`send ${label}${opts.exclusive ? " (exclusive)" : ""}`);
    await this.session.sendUserInput({ inputId: sendId, text });
    return reply;
  }

  whenIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private checkIdle(): void {
    if (!this.idle) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private answer(turn: TurnRecord, ids: string[]): void {
    for (const id of ids) {
      if (!turn.answers.includes(id)) turn.answers.push(id);
      const waiter = this.waiting.get(id);
      if (!waiter) {
        this.warnings.push(
          `turn ${turn.turnId.slice(0, 8)} echoes ${id.slice(0, 8)}, which nobody waits for`,
        );
        continue;
      }
      waiter.turnId ??= turn.turnId;
      waiter.firstFrameAt ??= Date.now();
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.session.events) this.handle(message);
      this.note("stream ended");
    } catch (error) {
      this.note(`stream threw: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ended = true;
      for (const waiter of this.waiting.values()) {
        this.warnings.push(`${waiter.label} got no reply: the stream ended`);
        waiter.reject(new Error(`${waiter.label}: the SDK stream ended without a reply`));
      }
      this.waiting.clear();
      this.current = undefined;
      this.checkIdle();
    }
  }

  private handle(raw: AgentMessage): void {
    const message = raw as AgentMessage | SdkTurnEvent;
    switch (message.type) {
      case "sdk_turn_start": {
        const turn: TurnRecord = {
          turnId: message.turnId,
          startedBy: message.startedBy,
          answers: [],
          startedAt: Date.now(),
          text: "",
          tools: [],
          cards: [],
          submits: [],
        };
        this.current = turn;
        this.turns.push(turn);
        this.answer(turn, message.answers);
        this.note(
          `turn ${turn.turnId.slice(0, 8)} start (${message.startedBy}) answers=[${message.answers.map((id) => this.name(id))}]`,
        );
        return;
      }
      case "sdk_turn_answers": {
        if (!this.current) return;
        this.answer(this.current, message.added);
        this.note(
          `turn ${this.current.turnId.slice(0, 8)} also answers [${message.added.map((id) => this.name(id))}]`,
        );
        return;
      }
      case "sdk_turn_end": {
        const turn = this.current;
        if (!turn) return;
        this.answer(turn, message.answers);
        turn.endedAt = Date.now();
        turn.subtype = message.subtype;
        this.note(
          `turn ${turn.turnId.slice(0, 8)} end ${message.subtype} answers=[${turn.answers.map((id) => this.name(id))}]`,
        );
        for (const id of turn.answers) {
          const waiter = this.waiting.get(id);
          if (!waiter) continue;
          waiter.answeredBy.push(turn.turnId);
          this.waiting.delete(id);
          waiter.resolve({
            sendId: id,
            turnId: waiter.turnId ?? turn.turnId,
            answeredBy: waiter.answeredBy,
            text: turn.text,
            terminal: turn.terminal,
            sentAt: waiter.sentAt,
            firstFrameMs: waiter.firstFrameAt ? waiter.firstFrameAt - waiter.sentAt : undefined,
            totalMs: Date.now() - waiter.sentAt,
          });
        }
        this.current = undefined;
        this.checkIdle();
        return;
      }
    }
    const turn = this.current;
    if (!turn) {
      if (message.type !== "input_status") this.note(`(outside a turn) ${message.type}`);
      return;
    }
    if (message.type === "text") turn.text += (turn.text ? "\n" : "") + message.content;
    else if (message.type === "tool_use") turn.tools.push(message.tool);
    else if (message.type === "tool_result") {
      const output =
        typeof message.output === "string" ? message.output : JSON.stringify(message.output);
      if (output.includes("pendingInteraction")) {
        turn.cards.push({ turnId: turn.turnId, answering: [...turn.answers], tool: message.tool });
        this.note(`turn ${turn.turnId.slice(0, 8)} card from ${message.tool}`);
      }
    } else if (message.type === "result" || message.type === "error") {
      turn.terminal =
        message.type === "result"
          ? { type: "result", content: message.content }
          : { type: "error", error: message.error };
    } else if (message.type === "input_status" && message.state === "consumed") {
      if (this.labels.has(message.inputId)) this.note(`read ${this.name(message.inputId)}`);
    }
  }

  /** For the provider's executeSubmitOutput: attribute to the turn now streaming. */
  recordSubmit(payload: unknown): void {
    const turn = this.current;
    const record = { turnId: turn?.turnId, answering: [...(turn?.answers ?? [])], payload };
    if (turn) turn.submits.push(record);
    else this.warnings.push("submit_output outside a turn");
    this.note(
      `submit_output in turn ${turn?.turnId.slice(0, 8)} answering [${record.answering.map((id) => this.name(id))}]`,
    );
  }

  get streamEnded(): boolean {
    return this.ended;
  }
}
