// An app's lifecycle as one Cordis fiber. Everything Rome registers for an app
// is an effect under that fiber, and stopping the app disposes it, which runs
// every undo once, newest first.

import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { Skill } from "../../agent/index.js";
import type { Action } from "../actions/types.js";
import type { ArtifactMetadata } from "../types.js";

/** The registry of every app's actions. `add` returns the entry's undo. */
export interface ActionsService {
  add(action: Action, metadata: ArtifactMetadata): () => void;
}

/** The catalog of every app's skills. `add` returns the entry's undo. */
export interface SkillsService {
  add(skill: Skill): () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    actions: ActionsService;
    skills: SkillsService;
  }
}

/** A kind of thing an app brings, registered and replaced as one batch. */
export type AppArtifactKind = "actions" | "skills";

interface RunningApp {
  fiber: Fiber;
  ctx: Context;
  kinds: Map<AppArtifactKind, Fiber>;
}

export class AppFibers {
  private readonly root = new Context();
  private readonly running = new Map<string, RunningApp>();

  constructor(services: { actions: ActionsService; skills: SkillsService }) {
    this.root.provide("actions", services.actions);
    this.root.provide("skills", services.skills);
  }

  /**
   * Replaces what the app holds of one kind: the previous batch is disposed,
   * then `register` runs in a new child fiber of the app's fiber. Starts the
   * app's fiber on its first batch.
   */
  async contribute(
    appId: string,
    kind: AppArtifactKind,
    register: (ctx: Context) => void,
  ): Promise<void> {
    const app = await this.ensure(appId);
    await app.kinds.get(kind)?.dispose();
    // A fresh object per call: Cordis keys a plugin by its identity.
    const child = app.ctx.plugin({
      name: `app:${appId}/${kind}`,
      inject: ["actions", "skills"],
      apply: register,
    });
    app.kinds.set(kind, child);
    await child;
  }

  /** Disposes the app's fiber and everything under it. Does nothing when the app is not running. */
  async stop(appId: string): Promise<void> {
    const app = this.running.get(appId);
    if (!app) return;
    this.running.delete(appId);
    await app.fiber.dispose();
  }

  /** Labels of what the app's fiber still holds, for "what is this app holding?". */
  heldBy(appId: string): string[] {
    const app = this.running.get(appId);
    if (!app) return [];
    return [...app.kinds.values()].flatMap((child) =>
      child.getEffects().map((effect) => effect.label),
    );
  }

  async close(): Promise<void> {
    await this.root.fiber.dispose();
    this.running.clear();
  }

  private async ensure(appId: string): Promise<RunningApp> {
    const existing = this.running.get(appId);
    if (existing) return existing;
    let appCtx: Context | undefined;
    const fiber = this.root.plugin({
      name: `app:${appId}`,
      apply(ctx: Context) {
        appCtx = ctx;
      },
    });
    await fiber;
    if (!appCtx) throw new Error(`app fiber for ${appId} did not start`);
    const app: RunningApp = { fiber, ctx: appCtx, kinds: new Map() };
    this.running.set(appId, app);
    return app;
  }
}

/** Registers each action as an effect of the calling fiber. */
export function addActions(
  entries: readonly { action: Action; metadata: ArtifactMetadata }[],
): (ctx: Context) => void {
  return (ctx) => {
    for (const { action, metadata } of entries) {
      ctx.effect(() => ctx.actions.add(action, metadata), `action:${action.config.name}`);
    }
  };
}

/** Registers each skill as an effect of the calling fiber. */
export function addSkills(skills: readonly Skill[]): (ctx: Context) => void {
  return (ctx) => {
    for (const skill of skills) {
      ctx.effect(() => ctx.skills.add(skill), `skill:${skill.name}`);
    }
  };
}
