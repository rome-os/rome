import type { AgentEvent } from "../../types.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelRunParams,
  type ModelSession,
  type ModelSessionParams,
} from "../../core/agent-runner.js";

// FakeModel — scriptable ModelProvider for the testkit.
//
// The model API is a genuine process boundary, so it is the one place agent
// tests are allowed to fake. Unlike `MockModelProvider` (fixed response
// queue), FakeModel scripts are matched per turn and can drive REAL action
// execution: an `invokeAction` step calls the provider's `executeAction`
// callback, which the real AgentSession wires to the real ActionEngine — so
// everything below the model (engine, repos, DB) runs for real.

export interface ActionCallStep {
  kind: "invoke_action";
  name: string;
  args: Record<string, unknown>;
}

/** One scripted element of a turn: a message to emit, or an action to invoke. */
export type ReplyStep = AgentEvent | ActionCallStep;

export function text(content: string): AgentEvent {
  return { type: "text", content };
}

export function thinking(content: string): AgentEvent {
  return { type: "thinking", content };
}

export function result(content: string): AgentEvent {
  return { type: "result", content };
}

export function errorMessage(error: string): AgentEvent {
  return { type: "error", error };
}

/**
 * Script step that makes the fake model call a real action through the
 * session's `executeAction` callback, emitting the same `tool_use` /
 * `tool_result` message pair a real provider would.
 */
export function invokeAction(name: string, args: Record<string, unknown> = {}): ActionCallStep {
  return { kind: "invoke_action", name, args };
}

function isActionCallStep(step: ReplyStep): step is ActionCallStep {
  return "kind" in step && step.kind === "invoke_action";
}

interface ReplyRule {
  matches: (params: ModelRunParams) => boolean;
  steps: ReplyStep[];
  once: boolean;
  used: boolean;
}

export interface ReplyBuilder {
  /** Use these steps every time the matcher hits. */
  reply(...steps: ReplyStep[]): FakeModel;
  /** Use these steps for the first matching turn only. */
  replyOnce(...steps: ReplyStep[]): FakeModel;
}

export class FakeModel implements ModelProvider {
  readonly id = "mock" as const;
  readonly displayName = "Fake Model";
  builtinTools: ReadonlySet<string> = new Set();

  /** Every turn the model was asked to run, in order. */
  calls: ModelRunParams[] = [];
  /** Every session opened against the provider, in order. */
  sessions: ModelSessionParams[] = [];

  private rules: ReplyRule[] = [];
  private queued: ReplyStep[][] = [];
  private defaultSteps: ReplyStep[] = [result("OK")];
  private toolUseSeq = 0;

  /** Script a reply for turns whose user prompt matches. */
  whenPromptIncludes(needle: string | RegExp): ReplyBuilder {
    const matches = (params: ModelRunParams) =>
      typeof needle === "string" ? params.prompt.includes(needle) : needle.test(params.prompt);
    return this.builderFor(matches);
  }

  /** Script a reply for an arbitrary per-turn predicate. */
  when(matches: (params: ModelRunParams) => boolean): ReplyBuilder {
    return this.builderFor(matches);
  }

  /** FIFO one-shot reply, consumed before rules are consulted. */
  queueReply(...steps: ReplyStep[]): this {
    this.queued.push(steps);
    return this;
  }

  /** Replace the fallback reply used when nothing else matches. */
  setDefaultReply(...steps: ReplyStep[]): this {
    this.defaultSteps = steps;
    return this;
  }

  /** User prompts received so far, in order. */
  prompts(): string[] {
    return this.calls.map((c) => c.prompt);
  }

  lastPrompt(): string | undefined {
    return this.calls.at(-1)?.prompt;
  }

  lastSystemPrompt(): string | undefined {
    return this.calls.at(-1)?.systemPrompt;
  }

  async *run(params: ModelRunParams): AsyncIterable<AgentEvent> {
    this.calls.push(params);
    const steps = this.nextSteps(params);

    let sawTerminal = false;
    let lastText: string | undefined;
    for (const step of steps) {
      if (isActionCallStep(step)) {
        const id = `faketool_${++this.toolUseSeq}`;
        yield { type: "tool_use", id, tool: step.name, input: step.args };
        // Real providers deliver tool failures (unknown action, allow-list
        // rejection, action throw) back to the model as an error tool_result;
        // letting the rejection escape the generator would instead kill the
        // whole session mid-turn, mis-modeling those paths.
        let output: unknown;
        try {
          output = await params.executeAction(step.name, step.args);
        } catch (err) {
          output = { error: err instanceof Error ? err.message : String(err) };
        }
        yield { type: "tool_result", toolUseId: id, tool: step.name, output };
        continue;
      }
      if (step.type === "result" || step.type === "error") {
        sawTerminal = true;
      }
      if (step.type === "text") {
        lastText = step.content;
      }
      yield step;
    }

    // Every real turn ends with a terminal block; scripts may omit it.
    if (!sawTerminal) {
      yield result(lastText ?? "OK");
    }
  }

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    this.sessions.push(params);
    return createSessionFromRun(this.id, (runParams) => this.run(runParams), params);
  }

  private builderFor(matches: ReplyRule["matches"]): ReplyBuilder {
    const add = (steps: ReplyStep[], once: boolean): FakeModel => {
      this.rules.push({ matches, steps, once, used: false });
      return this;
    };
    return {
      reply: (...steps) => add(steps, false),
      replyOnce: (...steps) => add(steps, true),
    };
  }

  private nextSteps(params: ModelRunParams): ReplyStep[] {
    const queued = this.queued.shift();
    if (queued) return queued;
    for (const rule of this.rules) {
      if (rule.once && rule.used) continue;
      if (rule.matches(params)) {
        rule.used = true;
        return rule.steps;
      }
    }
    return this.defaultSteps;
  }
}
