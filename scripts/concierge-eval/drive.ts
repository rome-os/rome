// Plays the owner in one scenario's chat: sends its messages, answers the
// cards the Concierge shows as the scenario says, and waits until the chat
// and its tasks are quiet. docs/concierge-eval.md

import {
  type Api,
  type ChatMessage,
  type Question,
  type TaskCard,
  type TaskDto,
  partsOf,
} from "./api.js";
import type { CardOutcome } from "./metrics.js";
import type { Scenario } from "./scenarios.js";
import { sleep } from "./stack.js";

export interface DriveOptions {
  /** How long the chat must stay quiet before the next step, in ms. */
  settleMs: number;
  /** The most one scenario may take, in ms. */
  timeoutMs: number;
  pollMs: number;
  log: (line: string) => void;
}

export interface DriveResult {
  outcomes: CardOutcome[];
  tasks: TaskDto[];
  timedOut: boolean;
}

const now = () => Math.floor(Date.now() / 1000);

function answersFor(questions: Question[]): { values: string[]; text: string }[] {
  return questions.map((q) =>
    q.type === "text" || !q.options?.length
      ? { values: [], text: "Any is fine." }
      : { values: [q.options[0] as string], text: "" },
  );
}

/** The newest Concierge text message, preferring one in a task's thread. */
function latestResult(messages: ChatMessage[]): ChatMessage | undefined {
  const texts = messages.filter(
    (m) => m.role === "assistant" && partsOf(m).some((p) => p.type === "text"),
  );
  return texts.filter((m) => m.chatThreadId).at(-1) ?? texts.at(-1);
}

export async function drive(
  api: Api,
  chatId: string,
  scenario: Scenario,
  options: DriveOptions,
): Promise<DriveResult> {
  const deadline = Date.now() + options.timeoutMs;
  const handled = new Set<string>();
  const outcomes: CardOutcome[] = [];
  const endedNoResponse = new Set<string>();
  let tasks: TaskDto[] = [];

  const answerCards = async (messages: ChatMessage[]) => {
    const answeredOwn = new Set(
      messages.flatMap((m) =>
        partsOf(m)
          .filter((p) => p.type === "interaction_result")
          .map((p) => String(p.toolUseId)),
      ),
    );
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of partsOf(message)) {
        if (part.type === "task_chat" && part.card) {
          const card = part.card as TaskCard;
          if (!card.id || card.outcome || handled.has(card.id)) continue;
          if (card.kind === "question" && scenario.cards === "first" && !card.expired) {
            const answers = answersFor(card.render?.props?.questions ?? []);
            handled.add(card.id);
            await api.answerCard(card.messageId as string, answers);
            outcomes.push({ at: now(), words: answers.flatMap((a) => a.values) });
            options.log(`answered task card ${card.id}: ${JSON.stringify(answers)}`);
          } else if (card.kind === "approval" && scenario.approvals !== "never") {
            handled.add(card.id);
            await api.decideApproval(card.id, scenario.approvals);
            outcomes.push({
              at: now(),
              words: [scenario.approvals === "approve" ? "approved" : "rejected"],
            });
            options.log(
              `${scenario.approvals === "approve" ? "approved" : "rejected"} approval ${card.id}`,
            );
          }
        } else if (part.type === "pending_interaction") {
          const id = String(part.toolUseId);
          if (answeredOwn.has(id) || handled.has(id) || scenario.cards !== "first") continue;
          const render = part.render as { props?: { questions?: Question[] } } | undefined;
          const answers = answersFor(render?.props?.questions ?? []);
          handled.add(id);
          await api.answerCard(message.id, answers);
          outcomes.push({ at: now(), words: answers.flatMap((a) => a.values) });
          options.log(`answered the Concierge's own card ${id}`);
        } else if (part.type === "approval_card" && part.status === "pending") {
          const id = String(part.approvalId);
          if (handled.has(id) || scenario.approvals === "never") continue;
          handled.add(id);
          await api.decideApproval(id, scenario.approvals);
          outcomes.push({
            at: now(),
            words: [scenario.approvals === "approve" ? "approved" : "rejected"],
          });
        }
      }
    }
  };

  /** Waits until no turn runs and no task is active or waits on the owner, for settleMs in a row. */
  const settle = async (): Promise<boolean> => {
    let quietSince: number | null = null;
    while (Date.now() < deadline) {
      const messages = await api.messages(chatId);
      await answerCards(messages);
      const [turns, current] = await Promise.all([api.turns(chatId), api.tasks(chatId)]);
      tasks = current;
      for (const task of tasks) {
        if (task.endReason === "no_response" && !endedNoResponse.has(task.id)) {
          endedNoResponse.add(task.id);
          outcomes.push({ at: now(), words: ["expired", "no response"] });
          options.log(`task "${task.title}" ended for no response`);
        }
      }
      const open = tasks.filter((t) => t.status === "active" || t.status === "needs_you");
      if (turns.length === 0 && open.length === 0) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= options.settleMs) return true;
      } else quietSince = null;
      await sleep(options.pollMs);
    }
    return false;
  };

  for (const step of scenario.steps) {
    const replyTo = step.replyToResult ? latestResult(await api.messages(chatId))?.id : undefined;
    if (step.replyToResult && !replyTo) options.log("no result to reply to: sent plain");
    await api.send(chatId, step.text, replyTo);
    options.log(`sent${replyTo ? ` as a reply to ${replyTo}` : ""}: ${step.text.slice(0, 60)}`);
    if (!(await settle())) return { outcomes, tasks, timedOut: true };
  }
  return { outcomes, tasks, timedOut: false };
}
