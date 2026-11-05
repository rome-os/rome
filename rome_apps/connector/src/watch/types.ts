// The shapes watching is built from: what a source lets Rome watch (its
// catalog), an event in the common shape a follower reads, and the adapter
// each source implements. The actions and the shared code reach a source only
// through its adapter, found in the registry, and never name one.

import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";

/**
 * One raw event a kind listens on, by the provider and event type this app
 * declares under `eventSources` in app.yaml; its bus name follows from them.
 * `{target}` in an `equals` is the followed target.
 */
export interface WatchTrigger {
  provider: string;
  type: string;
  filter?: { field: string; equals: string }[];
}

export interface WatchKind {
  kind: string;
  label: string;
  /** On when the guardian follows something and names no kinds. */
  default: boolean;
  triggers: WatchTrigger[];
}

export interface WatchOption {
  key: string;
  label: string;
  type: "enum" | "boolean" | "list";
  /** The allowed values of an enum, with the words the guardian reads for each. */
  values?: { value: string; label: string }[];
  default: string | boolean | string[];
  /** What a list holds, such as GitHub logins. */
  itemHint?: string;
}

/**
 * What a source lets Rome watch: the kinds of event a follower may turn on, in
 * words the guardian reads, the options that tune them, and the raw bus events
 * behind each kind. Core reads it through the `connector_watch_sources` action.
 */
export interface Watchable {
  source: string;
  label: string;
  /** What a follow names at the source, or null: the connected account itself. */
  target: { format: string; example: string } | null;
  kinds: WatchKind[];
  options: WatchOption[];
}

/**
 * How an event is addressed to the guardian: `direct` when it is theirs or
 * asks them (sent To them, a review requested of them, their own pull
 * request), `copy` when they are copied, `other` otherwise.
 */
export type AddressedTo = "direct" | "copy" | "other";

/** An event as a follower reads it. Every text field came from outside Rome. */
export interface WatchEvent {
  /** Stable identity, so a repeat delivery is dropped. */
  id: string;
  source: string;
  kind: string;
  actor?: string;
  subject?: string;
  url?: string;
  excerpt?: string;
  /** The guardian did it. */
  byYou: boolean;
  addressedTo: AddressedTo;
  /** What else the connection knows, in short lowercase words. */
  labels: string[];
}

export type Normalized = { keep: true; event: WatchEvent } | { keep: false; reason: string };

export type Json = Record<string, unknown>;

/** A Composio trigger a kind listens on, with the config this app arms it with. */
export interface ComposioTriggerSpec {
  toolkit: string;
  slug: string;
  config: Record<string, unknown>;
  /** Config keys that narrow the trigger, which an armed one must leave unset to count. */
  unscoped?: string[];
}

/** A Composio service as its errors name it. */
export interface ComposioToolkit {
  toolkit: string;
  label: string;
}

/** A request to a connected service's own API, made through Composio with its account. */
export interface ComposioRequest {
  endpoint: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** What a subscription check or subscribe answers, or why it could not. */
export type EnsureOutcome = { ok: true; subscription: string } | { ok: false; error: string };

/** The Composio capabilities every Composio adapter shares. */
export interface ComposioEnv {
  /** False when Rome is not signed in to Composio. */
  signedIn(): Promise<boolean>;
  /** Composio's connected accounts, as this app's `GET /connectors` lists them. */
  accounts(): Promise<{ toolkit: string; status: string }[]>;
  /** The connected account's id, or a readable reason there is none. */
  accountId(service: ComposioToolkit): Promise<string>;
  /** One read from the service's API through its connected account. */
  read(service: ComposioToolkit, request: ComposioRequest): Promise<Json>;
  /** Where the Composio project's one webhook delivers: here, elsewhere, nowhere, or unknown. */
  webhookTarget(): Promise<"ours" | "elsewhere" | "none" | "unknown">;
  /** Checks, or arms, the triggers for the connected account. */
  ensureTriggers(
    service: ComposioToolkit,
    specs: readonly ComposioTriggerSpec[],
    dryRun: boolean,
  ): Promise<EnsureOutcome>;
}

/** What every adapter may use: this app's runtime, the relay, and Composio. It names no service. */
export interface WatchEnv {
  app: AppActionRuntimeDeps;
  relayDepositUrl(): Promise<string | null>;
  composio: ComposioEnv;
}

/** One source's watching: its catalog, its account, its subscriptions and its normalizer. */
export interface WatchAdapter {
  source: string;
  catalog: Watchable;
  /** The bus events this adapter delivers: exact names, or a prefix ending in `*`. */
  events: readonly string[];
  /** Its events come through the Composio project's webhook, which one Rome at a time receives. */
  viaComposioWebhook?: true;
  /** Whether the source is connected to Rome at all. */
  connected(env: WatchEnv): Promise<boolean>;
  /** Whose account the events concern, or why that cannot be read. */
  account(env: WatchEnv): Promise<string>;
  /** Checks, or creates, the subscription a follow of these kinds needs. */
  ensure(
    env: WatchEnv,
    input: { target: string | undefined; kinds: string[]; dryRun: boolean },
  ): Promise<EnsureOutcome>;
  /** Checks, or creates, the subscription a `defer` on one of its events needs. */
  ensureEvent(
    env: WatchEnv,
    input: { eventName: string; filter: { field: string; equals: string }[]; dryRun: boolean },
  ): Promise<EnsureOutcome>;
  /**
   * One raw event in the common shape, or null when the event is not one this
   * adapter reads. It throws when a read it needed failed, so the event is
   * tried again.
   */
  normalize(
    env: WatchEnv,
    input: { eventName: string; payload: Json; account: string; kinds: string[] },
  ): Promise<Normalized | null>;
}
