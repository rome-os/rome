// Shared test fixtures. No Rstest imports here so all three
// test agents (registry, ledger, rehydration) can import from this one file.
//
// Fake descriptors mirror the canonical connection kinds. Each holds one grant:
//   pasteTalk       — telegram-like: one tokenPaste grant → Talker
//   botAll          — discord-like: one tokenPaste grant → talker+watcher+actor
//   renewableAct    — github-like: one renewable grant → Actor (N renewals, then re-confer)
//   gatedWatch      — github-like: one grant → Watcher with subscriptionGated:true
//   externalCustody — Composio-like: scheme with resolveExternal; no secrets in ledger
//
// All factories produce plain objects — no singletons, safe to call per test.

import type { ChannelMessage, Attachment, ChatId, MessageReceipt } from "@rome-os/app-runtime";
import { CredentialRejected, Disconnected } from "./errors.js";
import type {
  Actor,
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  GrantCustody,
  GrantName,
  OperationCall,
  OperationResult,
  OutgoingMessage,
  ProfileRecord,
  SecretRecord,
  Talker,
  Watcher,
  WatchEvent,
} from "./types.js";
import { tokenPaste } from "./schemes.js";

// recordingSleep — replaces the registry's sleep(ms) in backoff tests.

export interface RecordingSleep {
  /** The durations (ms) that have been requested, in order. */
  readonly durations: number[];
  /** Drop-in replacement for (ms: number) => Promise<void>. */
  fn: (ms: number) => Promise<void>;
}

export function makeRecordingSleep(): RecordingSleep {
  const durations: number[] = [];
  return {
    durations,
    fn: (ms: number) => {
      durations.push(ms);
      return Promise.resolve();
    },
  };
}

// Fake Talker

export interface FakeTalkerState {
  /** The `deliver` callback passed to start(). Null until start() is called. */
  deliver: ((msg: ChannelMessage) => void) | null;
  /** The `fault` callback passed to start(). Null until start() is called. */
  fault: ((err: CredentialRejected | Disconnected) => void) | null;
  /** Every start() call is recorded here with the credential at the time. */
  starts: Array<{ cred: Credential }>;
  stopCount: number;
  sends: Array<{ address: ChatId; msg: OutgoingMessage }>;
  /** If set, the next send() call will throw this error (then clear). */
  nextSendError: Error | null;
  /** If set, start() synchronously delivers these messages via the deliver
   *  callback before returning — models a Talker flushing buffered inbound on
   *  start. Used to prove onUnlocked fires before start() so a handler registered
   *  synchronously in the callback catches the first delivery. */
  flushOnStart: ChannelMessage[] | null;
  /** Number of stop() drains awaited to completion. */
  stopResolved: number;
}

/** A fake Talker that records all interactions and exposes the captured
 *  deliver/fault callbacks so tests can push messages and faults in. */
export interface FakeTalker extends Talker {
  readonly state: FakeTalkerState;
}

/** Options for makeFakeTalker. */
export interface FakeTalkerOptions {
  /** If true, stop() returns a promise that resolves on the next microtask AND
   *  bumps state.stopResolved when it resolves — models grammy's async drain so
   *  awaitable-shutdown tests can prove stopAll() waits for it. */
  asyncStop?: boolean;
}

export function makeFakeTalker(cred: Credential, opts?: FakeTalkerOptions): FakeTalker {
  const state: FakeTalkerState = {
    deliver: null,
    fault: null,
    starts: [],
    stopCount: 0,
    sends: [],
    nextSendError: null,
    flushOnStart: null,
    stopResolved: 0,
  };

  const talker: FakeTalker = {
    state,
    start(deliver, fault) {
      state.deliver = deliver;
      state.fault = fault;
      state.starts.push({ cred });
      // Synchronously flush any buffered inbound (models a Talker that delivers
      // from start()). This runs AFTER onUnlocked fired, so a handler registered
      // synchronously in the callback is already wired.
      if (state.flushOnStart) {
        for (const msg of state.flushOnStart) deliver(msg);
      }
    },
    stop() {
      state.stopCount++;
      if (opts?.asyncStop) {
        return Promise.resolve().then(() => {
          state.stopResolved++;
        });
      }
    },
    async send(address, msg) {
      if (state.nextSendError !== null) {
        const err = state.nextSendError;
        state.nextSendError = null;
        throw err;
      }
      state.sends.push({ address, msg });
      return {
        chatId: address,
      } satisfies MessageReceipt;
    },
  };

  return talker;
}

// Fake Actor

export interface FakeActorState {
  invocations: Array<{ call: OperationCall; cred: Credential }>;
  /** If set, the next invoke() call will throw this error (then clear). */
  nextInvokeError: Error | null;
  stopCount: number;
}

export interface FakeActor extends Actor {
  readonly state: FakeActorState;
}

export function makeFakeActor(cred: Credential): FakeActor {
  const state: FakeActorState = {
    invocations: [],
    nextInvokeError: null,
    stopCount: 0,
  };

  const actor: FakeActor = {
    state,
    operations: () => [],
    async invoke(call: OperationCall): Promise<OperationResult> {
      if (state.nextInvokeError !== null) {
        const err = state.nextInvokeError;
        state.nextInvokeError = null;
        throw err;
      }
      state.invocations.push({ call, cred });
      return { ok: true };
    },
    stop() {
      state.stopCount++;
    },
  };

  return actor;
}

// Fake Watcher

export interface FakeWatcherState {
  /** The `emit` callback passed to start(). Null until start() is called. */
  emit: ((event: WatchEvent) => void) | null;
  /** The `fault` callback passed to start(). Null until start() is called. */
  fault: ((err: CredentialRejected | Disconnected) => void) | null;
  /** Every start() call recorded with the credential. */
  starts: Array<{ cred: Credential }>;
  stopCount: number;
}

export interface FakeWatcher extends Watcher {
  readonly state: FakeWatcherState;
}

export function makeFakeWatcher(cred: Credential): FakeWatcher {
  const state: FakeWatcherState = {
    emit: null,
    fault: null,
    starts: [],
    stopCount: 0,
  };

  const watcher: FakeWatcher = {
    state,
    start(emit, fault) {
      state.emit = emit;
      state.fault = fault;
      state.starts.push({ cred });
    },
    stop() {
      state.stopCount++;
    },
  };

  return watcher;
}

// FakeTalkerFactory / FakeActorFactory / FakeWatcherFactory

// Factories that remember every instance built so tests can reach into them.
// Each factory.instances[n] is the nth fake created (in build() call order).

export interface FakeTalkerFactory {
  readonly instances: FakeTalker[];
  build(cred: Credential): FakeTalker;
}

export function makeFakeTalkerFactory(opts?: FakeTalkerOptions): FakeTalkerFactory {
  const instances: FakeTalker[] = [];
  return {
    instances,
    build(cred) {
      const t = makeFakeTalker(cred, opts);
      instances.push(t);
      return t;
    },
  };
}

export interface FakeActorFactory {
  readonly instances: FakeActor[];
  build(cred: Credential): FakeActor;
}

export function makeFakeActorFactory(): FakeActorFactory {
  const instances: FakeActor[] = [];
  return {
    instances,
    build(cred) {
      const a = makeFakeActor(cred);
      instances.push(a);
      return a;
    },
  };
}

export interface FakeWatcherFactory {
  readonly instances: FakeWatcher[];
  build(cred: Credential): FakeWatcher;
}

export function makeFakeWatcherFactory(): FakeWatcherFactory {
  const instances: FakeWatcher[] = [];
  return {
    instances,
    build(cred) {
      const w = makeFakeWatcher(cred);
      instances.push(w);
      return w;
    },
  };
}

// Fake renewable AuthScheme

/**
 * A headless AuthScheme that:
 * - confer(): immediately returns a credential without interaction.
 * - renew(): returns fresh credentials `successCount` times (decrements each
 *   call), then returns "re-confer" forever. Pass Infinity to always renew.
 * - resolveExternal: optional, enables external-custody tests.
 */
export interface FakeRenewableScheme extends AuthScheme {
  /** Number of remaining successful renewals (starts at the configured value). */
  renewsRemaining: number;
  /** Materials handed out by confer() and each successful renew(). */
  readonly materialHistory: SecretRecord[];
}

export function makeFakeRenewableScheme(opts?: {
  successCount?: number;
  initialMaterial?: SecretRecord;
  resolveExternal?: () => Promise<SecretRecord>;
}): FakeRenewableScheme {
  let successCount = opts?.successCount ?? Number.POSITIVE_INFINITY;
  const initialMaterial: SecretRecord = opts?.initialMaterial ?? { token: "initial-token" };
  const materialHistory: SecretRecord[] = [];

  const scheme: FakeRenewableScheme = {
    materialHistory,
    get renewsRemaining() {
      return successCount;
    },
    set renewsRemaining(n: number) {
      successCount = n;
    },

    async confer(_interact): Promise<Credential> {
      const material: SecretRecord = { token: `conferred-${materialHistory.length}` };
      if (materialHistory.length === 0) {
        // First confer returns the configured initial material.
        Object.assign(material, initialMaterial);
        materialHistory.push(material);
      } else {
        materialHistory.push(material);
      }
      return { material, expiresAt: "never" };
    },

    async renew(_cred): Promise<Credential | "re-confer"> {
      if (successCount <= 0) return "re-confer";
      successCount--;
      const material: SecretRecord = { token: `renewed-${materialHistory.length}` };
      materialHistory.push(material);
      return { material, expiresAt: "never" };
    },

    ...(opts?.resolveExternal ? { resolveExternal: opts.resolveExternal } : {}),
  };

  return scheme;
}

// Helpers for building ChannelMessage / WatchEvent in tests

export function makeInboundMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  const attachments: Attachment[] = [];
  return {
    channel: "test",
    direction: "inbound",
    messageId: "msg-1",
    chatId: "thread-1" as ChatId,
    senderId: "sender-1",
    senderDisplayName: "Sender",
    thread: { kind: "dm" },
    text: "hello",
    attachments,
    timestamp: new Date(0),
    ...overrides,
  };
}

export function makeWatchEvent(overrides?: Partial<WatchEvent>): WatchEvent {
  return {
    eventId: "event-1",
    eventType: "push",
    payload: {},
    ...overrides,
  };
}

// Descriptor: pasteTalk (telegram-like)
//
// One tokenPaste grant "bot" → Talker. validate is a no-op (always valid).

export interface PasteTalkFixture {
  descriptor: ConnectionDescriptor;
  talkerFactory: FakeTalkerFactory;
  /** Call this inside a confer call to supply a valid token. */
  validCredential: () => Credential;
}

export function makePasteTalk(opts?: FakeTalkerOptions): PasteTalkFixture {
  const talkerFactory = makeFakeTalkerFactory(opts);

  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-telegram",
    // Names its account by the profile's `botId`, as Telegram does.
    accountIdOf: (profile) => (typeof profile.botId === "string" ? profile.botId : null),
    takesAgent: true,
    grant: "bot",
    auth: tokenPaste({
      label: "Fake bot token",
      validate: async (_token: string) => {
        // Always valid in tests.
      },
    }),
    capabilities: {
      talker: {
        build(cred) {
          return talkerFactory.build(cred);
        },
      },
    },
  };

  const validCredential = (): Credential => ({
    material: { token: "fake-bot-token" },
    expiresAt: "never",
  });

  return { descriptor, talkerFactory, validCredential };
}

// Descriptor: botAll (discord-like)
//
// One tokenPaste grant "bot" → talker + watcher + actor.

export interface BotAllFixture {
  descriptor: ConnectionDescriptor;
  talkerFactory: FakeTalkerFactory;
  watcherFactory: FakeWatcherFactory;
  actorFactory: FakeActorFactory;
  botScheme: AuthScheme; // tokenPaste — renew is always "re-confer"
  /** Valid credential for the "bot" grant. */
  botCredential: () => Credential;
}

export function makeBotAll(): BotAllFixture {
  const talkerFactory = makeFakeTalkerFactory();
  const watcherFactory = makeFakeWatcherFactory();
  const actorFactory = makeFakeActorFactory();

  const botScheme = tokenPaste({
    label: "Fake Discord bot token",
    validate: async (_token: string) => {
      // Always valid in tests.
    },
  });

  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-discord",
    grant: "bot",
    auth: botScheme,
    capabilities: {
      talker: {
        build(cred) {
          return talkerFactory.build(cred);
        },
      },
      watcher: {
        build(cred) {
          return watcherFactory.build(cred);
        },
      },
      actor: {
        build(cred) {
          return actorFactory.build(cred);
        },
      },
    },
  };

  const botCredential = (): Credential => ({
    material: { token: "fake-discord-bot-token" },
    expiresAt: "never",
  });

  return { descriptor, talkerFactory, watcherFactory, actorFactory, botScheme, botCredential };
}

// Descriptor: renewableAct (github-like)
//
// One grant "user" whose scheme renews N times then "re-confer".
// Used to test: renew-once-then-degrade, and re-authorize after degrade.

export interface RenewableActFixture {
  descriptor: ConnectionDescriptor;
  actorFactory: FakeActorFactory;
  userScheme: FakeRenewableScheme;
  /** Valid credential for the "user" grant. */
  userCredential: () => Credential;
}

export function makeRenewableAct(opts?: { successCount?: number }): RenewableActFixture {
  const actorFactory = makeFakeActorFactory();
  const userScheme = makeFakeRenewableScheme({
    successCount: opts?.successCount ?? 1,
    initialMaterial: { token: "initial-user-token" },
  });

  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-github",
    grant: "user",
    auth: userScheme,
    capabilities: {
      actor: {
        build(cred) {
          return actorFactory.build(cred);
        },
      },
    },
  };

  const userCredential = (): Credential => ({
    material: { token: "initial-user-token" },
    expiresAt: "never",
  });

  return { descriptor, actorFactory, userScheme, userCredential };
}

// Descriptor: gatedWatch (github-like)
//
// One tokenPaste grant "user" → a Watcher with subscriptionGated:true. Once the
// grant is held it stays "needs-subscription" until
// registry.setWatchSubscribed(id, true).

export interface GatedWatchFixture {
  descriptor: ConnectionDescriptor;
  watcherFactory: FakeWatcherFactory;
  /** Valid credential for the "user" grant. */
  userCredential: () => Credential;
}

export function makeGatedWatch(): GatedWatchFixture {
  const watcherFactory = makeFakeWatcherFactory();

  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-github-watch",
    grant: "user",
    auth: tokenPaste({ label: "Fake GitHub token", validate: async () => {} }),
    capabilities: {
      watcher: {
        subscriptionGated: true,
        build(cred) {
          return watcherFactory.build(cred);
        },
      },
    },
  };

  const userCredential = (): Credential => ({
    material: { token: "fake-github-token" },
    expiresAt: "never",
  });

  return { descriptor, watcherFactory, userCredential };
}

// Descriptor: externalCustody (Composio-like)
//
// A scheme with resolveExternal: the ledger must persist { kind: "external" }
// (no secret material) and the registry re-wraps the material at rehydration
// by calling resolveExternal instead of conferring again.
//
// The fixture exposes the resolver spy so tests can verify it was called and
// what material it produced.

export interface ExternalCustodyFixture {
  descriptor: ConnectionDescriptor;
  actorFactory: FakeActorFactory;
  scheme: FakeRenewableScheme;
  /** The external material returned by resolveExternal on every call. */
  externalMaterial: SecretRecord;
  /** Number of times resolveExternal has been called. */
  resolveExternalCallCount: () => number;
  /** Valid credential for the "account" grant (already external-form). */
  externalCredential: () => Credential;
}

export function makeExternalCustody(): ExternalCustodyFixture {
  const actorFactory = makeFakeActorFactory();
  const externalMaterial: SecretRecord = { apiKey: "composio-api-key" };
  let resolveCount = 0;

  const resolveExternal = async (): Promise<SecretRecord> => {
    resolveCount++;
    return { ...externalMaterial };
  };

  // confer() returns a credential whose material is a function (external resolver).
  // The ledger must persist this as { kind: "external" }.
  const scheme = makeFakeRenewableScheme({
    successCount: 0, // cannot renew — always "re-confer"
    resolveExternal,
  });

  // Override confer so it returns a function-valued material.
  const originalConfer = scheme.confer.bind(scheme);
  scheme.confer = async (_interact) => {
    // Ignore the base implementation; return a resolver-backed credential.
    void originalConfer; // silence unused-var lint
    return {
      material: resolveExternal,
      expiresAt: "never",
    };
  };

  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-composio",
    grant: "account",
    auth: scheme,
    capabilities: {
      actor: {
        build(cred) {
          return actorFactory.build(cred);
        },
      },
    },
  };

  // An "external" form credential as the registry would restore it at rehydration.
  const externalCredential = (): Credential => ({
    material: resolveExternal,
    expiresAt: "never",
  });

  return {
    descriptor,
    actorFactory,
    scheme,
    externalMaterial,
    resolveExternalCallCount: () => resolveCount,
    externalCredential,
  };
}

// Descriptor: custodyGrant (github/slack-like OAuth provider)
//
// One renewable grant "user" and NO capabilities, plus a recording GrantCustody.
// Models a Rome Cloud-OAuth provider whose only job in the registry is to drive
// out-of-process custody artifacts off grant state — proving custody fires on
// grant transitions independently of any capability build.

export interface CustodyRecorder extends GrantCustody {
  readonly syncs: Array<{ material: SecretRecord; profile: ProfileRecord }>;
  /** How many times clear() ran. */
  clears: number;
  /** If set, the NEXT sync() throws this (then clears) — models a disk error. */
  nextSyncError: Error | null;
}

export function makeCustodyRecorder(): CustodyRecorder {
  const syncs: CustodyRecorder["syncs"] = [];
  return {
    syncs,
    clears: 0,
    nextSyncError: null,
    async sync(material, profile) {
      if (this.nextSyncError !== null) {
        const err = this.nextSyncError;
        this.nextSyncError = null;
        throw err;
      }
      syncs.push({ material, profile });
    },
    async clear() {
      this.clears++;
    },
  };
}

export interface CustodyGrantFixture {
  descriptor: ConnectionDescriptor;
  custody: CustodyRecorder;
  userScheme: FakeRenewableScheme;
  /** Valid credential for the "user" grant. */
  userCredential: () => Credential;
}

export function makeCustodyGrant(opts?: { successCount?: number }): CustodyGrantFixture {
  const custody = makeCustodyRecorder();
  const userScheme = makeFakeRenewableScheme({
    successCount: opts?.successCount ?? 0,
    initialMaterial: { accessToken: "initial-user-token" },
  });

  const descriptor: ConnectionDescriptor = {
    connectionKind: "fake-oauth-provider",
    grant: "user",
    auth: userScheme,
    custody,
    capabilities: {},
  };

  const userCredential = (): Credential => ({
    material: { accessToken: "initial-user-token" },
    expiresAt: "never",
  });

  return { descriptor, custody, userScheme, userCredential };
}

// Re-exports used by test files

export { CredentialRejected, Disconnected };
