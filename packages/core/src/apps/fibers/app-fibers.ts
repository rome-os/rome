// Prototype: an app's lifecycle as one Cordis fiber. Everything Rome registers
// for an app is an effect in that fiber, and stopping the app disposes the
// fiber, which runs every undo once, newest first. Not wired into the
// composition root yet.

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

/** What one app brings, already loaded from its install directory. */
export interface AppContribution {
  appId: string;
  actions: { action: Action; metadata: ArtifactMetadata }[];
  skills: Skill[];
}

export class AppFibers {
  private readonly root = new Context();
  private readonly running = new Map<string, Fiber>();

  constructor(services: { actions: ActionsService; skills: SkillsService }) {
    this.root.provide("actions", services.actions);
    this.root.provide("skills", services.skills);
  }

  /** Starts an app in its own fiber. A running app is stopped first, which is an upgrade. */
  async start(app: AppContribution): Promise<void> {
    await this.stop(app.appId);
    // A fresh object per start: Cordis keys a plugin by its identity.
    const plugin = {
      name: `app:${app.appId}`,
      inject: ["actions", "skills"],
      apply(ctx: Context) {
        for (const { action, metadata } of app.actions) {
          ctx.effect(() => ctx.actions.add(action, metadata), `action:${action.config.name}`);
        }
        for (const skill of app.skills) {
          ctx.effect(() => ctx.skills.add(skill), `skill:${skill.name}`);
        }
      },
    };
    const fiber = this.root.plugin(plugin);
    this.running.set(app.appId, fiber);
    await fiber;
  }

  /** Disposes the app's fiber. Does nothing when the app is not running. */
  async stop(appId: string): Promise<void> {
    const fiber = this.running.get(appId);
    if (!fiber) return;
    this.running.delete(appId);
    await fiber.dispose();
  }

  /** Labels of what the app's fiber still holds, for "what is this app holding?". */
  heldBy(appId: string): string[] {
    return (
      this.running
        .get(appId)
        ?.getEffects()
        .map((effect) => effect.label) ?? []
    );
  }

  async close(): Promise<void> {
    await this.root.fiber.dispose();
    this.running.clear();
  }
}
