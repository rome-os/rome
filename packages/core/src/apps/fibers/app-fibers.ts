// An app's lifecycle as one Cordis fiber. Everything Rome registers for an app
// is an effect under that fiber, and stopping the app disposes it, which runs
// every undo once, newest first.

import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { Skill } from "../../agent/index.js";
import type { Action } from "../actions/types.js";
import type { ArtifactMetadata, RomeAppEventSource } from "../types.js";
import type { LoadedAgent } from "../agent-loader.js";
import type { LoadedLifecycleHook } from "../app-turn-hooks.js";
import type { LoadedMiddleware } from "../app-turn-middleware.js";

/** A registry Rome keeps for one kind of thing apps bring. `add` returns the entry's undo. */
export interface Registry<T> {
  add(entry: T): () => void;
}

/** A registry that keeps its entries in a list, in the order they were added. */
export class Collection<T> implements Registry<T> {
  private entries: readonly T[] = [];

  add(entry: T): () => void {
    this.entries = [...this.entries, entry];
    return () => {
      this.entries = this.entries.filter((existing) => existing !== entry);
    };
  }

  list(): readonly T[] {
    return this.entries;
  }
}

/** An `eventSources` entry from an app's manifest, tagged with the app. */
export interface AppEventSource extends RomeAppEventSource {
  appId: string;
}

/** An app's watch provider, its action names qualified by the app's id. */
export interface AppWatchProvider {
  appId: string;
  actions: { sources: string; ensure: string; normalize: string; release: string };
}

/** The registry of every app's actions. `add` returns the entry's undo. */
export interface ActionsService {
  add(action: Action, metadata: ArtifactMetadata): () => void;
}

/** Each kind of thing an app brings, as the Cordis service that registers it. */
export interface AppRegistries {
  actions: ActionsService;
  skills: Registry<Skill>;
  agents: Registry<LoadedAgent>;
  turnHooks: Registry<LoadedLifecycleHook>;
  turnMiddleware: Registry<LoadedMiddleware>;
  eventSources: Registry<AppEventSource>;
  watchProviders: Registry<AppWatchProvider>;
}

declare module "@deepseek-ai/cordis" {
  interface Context extends AppRegistries {}
}

/** A kind of thing an app brings, registered and replaced as one batch. */
export type AppArtifactKind = keyof AppRegistries;

interface RunningApp {
  fiber: Fiber;
  ctx: Context;
  kinds: Map<AppArtifactKind, Fiber>;
}

export class AppFibers {
  private readonly root = new Context();
  private readonly running = new Map<string, RunningApp>();

  constructor(registries: Partial<AppRegistries> = {}) {
    this.provide(registries);
  }

  /**
   * Provides registries, possibly after construction. A batch of a kind whose
   * registry is not provided yet waits, through Cordis `inject`, until it is.
   */
  provide(registries: Partial<AppRegistries>): void {
    for (const [kind, registry] of Object.entries(registries)) {
      this.root.provide(kind, registry);
    }
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
      inject: [kind],
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
      ctx.effect(() => ctx.actions.add(action, metadata), `actions:${action.config.name}`);
    }
  };
}

/** Registers each entry with the `kind` registry, as an effect of the calling fiber. */
export function addEntries<K extends Exclude<AppArtifactKind, "actions">>(
  kind: K,
  entries: readonly Parameters<AppRegistries[K]["add"]>[0][],
  label: (entry: Parameters<AppRegistries[K]["add"]>[0]) => string,
): (ctx: Context) => void {
  return (ctx) => {
    const registry = ctx[kind] as Registry<Parameters<AppRegistries[K]["add"]>[0]>;
    for (const entry of entries) {
      ctx.effect(() => registry.add(entry), `${kind}:${label(entry)}`);
    }
  };
}

/** Registers each skill as an effect of the calling fiber. */
export function addSkills(skills: readonly Skill[]): (ctx: Context) => void {
  return addEntries("skills", skills, (skill) => skill.name);
}
