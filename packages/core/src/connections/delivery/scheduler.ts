import type { DeliveryProfile } from "./profile.js";
import { DeliveryFailure } from "./transport.js";
import { scheduledPhysicalOperation } from "./physical-operation.js";

interface Work {
  conversation: string;
  kind: "create" | "update";
  profile: DeliveryProfile;
  execute(): Promise<void>;
}

interface Budget {
  queues: Map<string, Work[]>;
  running: boolean;
  next: number;
  tokens: number;
  replenishedAt: number;
  lastConversation?: string;
  conversations: Map<string, number>;
  routes: Map<string, number>;
}

/** One writer per shared budget. Conversation heads rotate after every physical operation. */
export class DeliveryScheduler {
  private readonly budgets = new Map<string, Budget>();

  constructor(
    private readonly now = () => Date.now(),
    private readonly sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  run<T>(
    profile: DeliveryProfile,
    conversation: string,
    kind: Work["kind"],
    assertAuthorized: () => void,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let budget = this.budgets.get(profile.budgetKey);
    if (!budget) {
      budget = {
        queues: new Map(),
        running: false,
        next: 0,
        tokens: profile.burstCapacity,
        replenishedAt: this.now(),
        conversations: new Map(),
        routes: new Map(),
      };
      this.budgets.set(profile.budgetKey, budget);
    }
    const owner = budget;
    const queued = [...owner.queues.values()].reduce((sum, queue) => sum + queue.length, 0);
    if (queued >= profile.maxQueuedOperations) {
      return Promise.reject(new DeliveryFailure("failed", "Delivery queue is full"));
    }
    return new Promise<T>((resolve, reject) => {
      let inFlight = false;
      const queue = owner.queues.get(conversation) ?? [];
      const abort = () => {
        if (inFlight) return;
        const waiting = owner.queues.get(conversation);
        if (waiting) {
          const position = waiting.indexOf(work);
          if (position >= 0) waiting.splice(position, 1);
          if (!waiting.length) owner.queues.delete(conversation);
        }
        signal?.removeEventListener("abort", abort);
        reject(new DeliveryFailure("failed", "Run output was stopped"));
      };
      const work: Work = {
        conversation,
        kind,
        profile,
        execute: async () => {
          try {
            signal?.throwIfAborted();
            assertAuthorized();
            inFlight = true;
            resolve(await scheduledPhysicalOperation.run(true, operation));
          } catch (error) {
            if (error instanceof DeliveryFailure && error.kind === "rate-limit") {
              owner.next = Math.max(owner.next, this.now() + (error.retryAfterMs ?? 1000));
            }
            reject(error);
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        },
      };
      queue.push(work);
      owner.queues.set(conversation, queue);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void this.drain(owner);
    });
  }

  private async drain(budget: Budget): Promise<void> {
    if (budget.running) return;
    budget.running = true;
    try {
      while (budget.queues.size) {
        const keys = [...budget.queues.keys()];
        const previous = keys.indexOf(budget.lastConversation ?? "");
        const key = keys[(previous + 1) % keys.length];
        const queue = budget.queues.get(key)!;
        const work = queue.shift()!;
        if (!queue.length) budget.queues.delete(key);
        const { profile, kind } = work;
        const routeKey = `${key}\0${kind}`;
        const spacing = profile.operationSpacingMs;
        if (spacing > 0) {
          const replenished = Math.floor((this.now() - budget.replenishedAt) / spacing);
          budget.tokens = Math.min(profile.burstCapacity, budget.tokens + replenished);
          budget.replenishedAt += replenished * spacing;
        }
        const ready = Math.max(
          budget.next,
          budget.conversations.get(key) ?? 0,
          budget.routes.get(routeKey) ?? 0,
          budget.tokens > 0 ? 0 : budget.replenishedAt + spacing,
        );
        if (ready > this.now()) await this.sleep(ready - this.now());
        budget.tokens = Math.max(0, budget.tokens - 1);
        if (budget.tokens === 0) budget.replenishedAt = this.now();
        budget.conversations.set(key, this.now() + profile.conversationSpacingMs);
        budget.routes.set(
          routeKey,
          this.now() + (kind === "create" ? profile.createSpacingMs : profile.updateSpacingMs),
        );
        budget.lastConversation = key;
        await work.execute();
        budget.conversations.set(key, this.now() + profile.conversationSpacingMs);
        budget.routes.set(
          routeKey,
          this.now() + (kind === "create" ? profile.createSpacingMs : profile.updateSpacingMs),
        );
        if (budget.tokens === 0) budget.next = Math.max(budget.next, this.now() + spacing);
      }
    } finally {
      budget.running = false;
    }
  }
}
