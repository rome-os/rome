import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { actionError, isRecord, type ActionResponse, type BinaryActionResult } from "../actions.js";
import { isUuid } from "../frame.js";
import { ComputerUseBridge } from "./bridge.js";
import { discoverHelper, type ComputerUseOptions } from "./discovery.js";
import {
  ComputerUseError,
  JSON_LIMIT,
  PNG_LIMIT,
  requestParams,
  type Results,
} from "./protocol.js";

const SESSION_TTL_MS = 5 * 60_000;
const MAX_PEERS = 8;
const MAX_BINDINGS = 8;
const MAX_ACTION_IDS = 1024;
const STOP_TIMEOUT_MS = 1000;
const empty = new Uint8Array();

function success(result: unknown, body: Uint8Array = empty): BinaryActionResult {
  return { response: { type: "response", ok: true, result }, body };
}

function failure(code: string, detail = code): BinaryActionResult {
  return { response: actionError(code, detail), body: empty };
}

function errorCode(cause: unknown): ComputerUseError["code"] {
  return cause instanceof ComputerUseError ? cause.code : "internal_error";
}

const errorMessages: Partial<Record<ComputerUseError["code"], string>> = {
  computer_use_unsupported_platform: "The Computer Use Helper requires macOS.",
  computer_use_helper_missing: "The Computer Use Helper is missing from this Mac.",
  action_outcome_unknown:
    "The Helper did not confirm the input outcome. Do not retry with a new action ID.",
};

type Bridge = Pick<
  ComputerUseBridge,
  | "instanceId"
  | "closed"
  | "windows"
  | "bind"
  | "unbind"
  | "observe"
  | "act"
  | "cancel"
  | "status"
  | "close"
  | "onDisconnect"
>;

interface HostDeps {
  discover: typeof discoverHelper;
  launch: (options: Parameters<typeof ComputerUseBridge.launch>[0]) => Promise<Bridge>;
  sessionTtlMs: number;
}

interface Binding {
  nativeId: string;
  window: number;
  instance: string;
  actions: Map<string, Promise<Results["act"]>>;
}

type StopResult = Results["cancel"];
const stopRequested: StopResult = { stop: "cancel_requested", reason: "session_stopped" };
const stopConfirmed: StopResult = { stop: "stop_confirmed", reason: "session_stopped" };

interface Session {
  peer: string;
  launch: AbortController;
  bindings: Map<string, Binding>;
  pending: number;
  working: boolean;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  bridge?: Bridge;
  stop?: Promise<StopResult>;
  stopped?: StopResult;
}

interface Operation {
  opensSession?: true;
  urgent?: true;
  run: (
    session: Session | undefined,
    args: unknown,
    binary: boolean,
    appPath?: string,
  ) => Promise<BinaryActionResult>;
}

interface PreparedOperation {
  run(refusal?: ActionResponse): Promise<BinaryActionResult>;
  release(): void;
}

export class ComputerUseHost {
  private readonly sessions = new Map<string, Session>();
  private readonly windows = new Map<number, Session>();
  private readonly deps: HostDeps;
  private discovering?: Promise<string>;

  constructor(
    private readonly options?: ComputerUseOptions,
    deps: Partial<HostDeps> = {},
  ) {
    this.deps = {
      discover: discoverHelper,
      launch: (options) => ComputerUseBridge.launch(options),
      sessionTtlMs: SESSION_TTL_MS,
      ...deps,
    };
  }

  private readonly operations = {
    "computer.windows": {
      opensSession: true,
      run: async (session, input, _binary, appPath) => {
        const args = requestParams("windows", input);
        const active = this.requireSession(session);
        return this.work(active, async () => {
          const bridge = await this.helper(active, appPath);
          this.check(active);
          const result = await bridge.windows(args?.application);
          this.check(active);
          return success(result);
        });
      },
    },
    "computer.bind": {
      opensSession: true,
      run: async (session, input, _binary, appPath) => {
        const { window } = requestParams("bind", input);
        return this.bind(this.requireSession(session), window, appPath);
      },
    },
    "computer.unbind": {
      run: async (session, input) => {
        const { binding: id } = requestParams("unbind", input);
        const { active, binding, bridge } = this.bound(session, id);
        return this.work(active, async () => {
          await this.changeBinding(active, () => bridge.unbind(binding.nativeId));
          this.check(active);
          this.releaseBinding(active, id);
          return success({ binding: id, released: true });
        });
      },
    },
    "computer.observe": {
      run: async (session, input, binary) => {
        const { binding: id, element, screenshot } = requestParams("observe", input);
        if (screenshot && !binary)
          return failure("screenshot_requires_binary", "Use binary output for screenshots.");
        const { active, binding, bridge } = this.bound(session, id);
        return this.work(active, async () => {
          const { screenshot: capture, ...observation } = await bridge.observe(binding.nativeId, {
            element,
            screenshot,
          });
          this.check(active);
          if (!capture) return success({ ...observation, binding: id });
          const { png, ...descriptor } = capture;
          if (png.byteLength > PNG_LIMIT) return failure("output_too_large");
          return success({ ...observation, binding: id, screenshot: descriptor }, png);
        });
      },
    },
    "computer.act": {
      run: async (session, input) => {
        if (!isRecord(input)) throw new ComputerUseError("invalid_request");
        const { actionId, ...args } = input;
        if (!isUuid(actionId)) throw new ComputerUseError("invalid_request");
        const { binding: id, ...action } = requestParams("act", args);
        const { active, binding, bridge } = this.bound(session, id);
        const key = actionId.toLowerCase();
        let pending = binding.actions.get(key);
        if (!pending) {
          if (active.working || binding.actions.size >= MAX_ACTION_IDS)
            throw new ComputerUseError("busy");
          // Keep the outcome for the full binding lifetime, including an unconfirmed dispatch.
          pending = this.work(active, () => bridge.act({ binding: binding.nativeId, ...action }));
          binding.actions.set(key, pending);
        }
        await pending;
        this.check(active);
        return success({ binding: id, actionId: key, dispatched: true });
      },
    },
    "computer.cancel": {
      urgent: true,
      run: async (session) => success(await this.cancel(session)),
    },
  } satisfies Record<string, Operation>;

  async info(peer: string) {
    if (isUuid(peer)) peer = peer.toLowerCase();
    const session = this.sessions.get(peer);
    let state: "ready" | "not_installed" | "unsupported_platform" = "ready";
    if (!session?.bridge || session.bridge.closed) {
      try {
        await this.findHelper();
      } catch (cause) {
        state =
          errorCode(cause) === "computer_use_unsupported_platform"
            ? "unsupported_platform"
            : "not_installed";
      }
    }
    const stopped = Boolean(this.sessions.get(peer)?.stop);
    const actions = Object.keys(this.operations);
    return {
      capability: {
        id: "computer_use",
        prefix: "computer",
        title: "Window Control",
        state,
        personal: true,
        actions,
      },
      actions: state === "ready" ? (stopped ? ["computer.cancel"] : actions) : [],
    };
  }

  prepare(
    action: string,
    peer: string,
    args: unknown,
    body?: Uint8Array,
  ): PreparedOperation | undefined {
    if (!Object.hasOwn(this.operations, action)) return;
    const operation: Operation = this.operations[action as keyof typeof this.operations];
    if (isUuid(peer)) peer = peer.toLowerCase();
    let session = this.sessions.get(peer);
    if (
      !session &&
      (operation.opensSession || operation.urgent) &&
      this.sessions.size < MAX_PEERS
    ) {
      session = {
        peer,
        launch: new AbortController(),
        bindings: new Map(),
        pending: 0,
        working: false,
        expiresAt: Infinity,
      };
      this.sessions.set(peer, session);
    }
    if (session) session.pending++;
    // Stop bypasses both audit I/O and ordinary request validation.
    const stopping = operation.urgent
      ? operation.run(session, args, body !== undefined)
      : undefined;
    const run = async (refusal?: ActionResponse) => {
      try {
        if (stopping) return await stopping;
        const appPath = session?.bridge ? undefined : await this.findHelper();
        if (session) this.check(session);
        if (refusal) return { response: refusal, body: empty };
        if (body?.byteLength)
          return failure("invalid_request", "Computer Use takes no binary input.");
        const result = await operation.run(session, args, body !== undefined, appPath);
        if (Buffer.byteLength(JSON.stringify(result.response)) > JSON_LIMIT)
          return failure("output_too_large");
        return result;
      } catch (cause) {
        const code = errorCode(cause);
        if (session?.bridge && code === "session_stopped" && !session.stop)
          void this.cancel(session);
        if (
          session &&
          (code === "binding_not_found" || code === "binding_unavailable") &&
          isRecord(args) &&
          isUuid(args.binding)
        ) {
          this.releaseBinding(session, args.binding);
        }
        return code === "capture_limit"
          ? failure("output_too_large")
          : failure(code, errorMessages[code]);
      }
    };
    return {
      run,
      release: () => {
        if (!session || --session.pending || session.bridge || session.stop) return;
        this.remove(session);
      },
    };
  }

  disconnect(): void {
    for (const session of this.sessions.values()) this.remove(session);
  }

  private findHelper(): Promise<string> {
    this.discovering ??= this.deps.discover(this.options).finally(() => {
      this.discovering = undefined;
    });
    return this.discovering;
  }

  private requireSession(session: Session | undefined): Session {
    if (!session) throw new ComputerUseError("busy");
    return session;
  }

  private check(session: Session): void {
    if (session.stop) throw new ComputerUseError("session_stopped");
    if (this.sessions.get(session.peer) !== session)
      throw new ComputerUseError("connection_closed");
    if (performance.now() >= session.expiresAt) {
      this.remove(session);
      throw new ComputerUseError("binding_not_found");
    }
  }

  private async work<T>(session: Session, run: () => Promise<T>): Promise<T> {
    this.check(session);
    if (session.working) throw new ComputerUseError("busy");
    session.working = true;
    try {
      return await run();
    } finally {
      session.working = false;
    }
  }

  private async helper(session: Session, appPath: string | undefined): Promise<Bridge> {
    this.check(session);
    if (session.bridge) return session.bridge;
    if (!appPath) throw new ComputerUseError("computer_use_helper_missing");
    const bridge = await this.deps.launch({
      appPath,
      signal: session.launch.signal,
      startupTimeoutMs: 8000,
      consentTimeoutMs: 35_000,
      consentMode: "session_only",
    });
    try {
      this.check(session);
    } catch (error) {
      bridge.close();
      throw error;
    }
    if (bridge.closed) throw new ComputerUseError("connection_closed");
    session.bridge = bridge;
    session.expiresAt = performance.now() + this.deps.sessionTtlMs;
    session.timer = setTimeout(() => this.remove(session), this.deps.sessionTtlMs).unref();
    bridge.onDisconnect(() => {
      if (!session.stop) this.remove(session);
    });
    return bridge;
  }

  private async bind(
    session: Session,
    window: number,
    appPath?: string,
  ): Promise<BinaryActionResult> {
    return this.work(session, async () => {
      if (this.windows.has(window)) throw new ComputerUseError("window_already_bound");
      if (session.bindings.size >= MAX_BINDINGS) throw new ComputerUseError("busy");
      this.windows.set(window, session);
      try {
        const bridge = await this.helper(session, appPath);
        this.check(session);
        const result = await this.changeBinding(session, () => bridge.bind(window));
        this.check(session);
        const id = randomUUID();
        session.bindings.set(id, {
          nativeId: result.binding,
          window,
          instance: bridge.instanceId,
          actions: new Map(),
        });
        return success({
          binding: id,
          window: result.window,
          bindingTTLms: Math.max(0, Math.floor(session.expiresAt - performance.now())),
        });
      } catch (cause) {
        if (!session.stop && this.windows.get(window) === session) this.windows.delete(window);
        throw cause;
      }
    });
  }

  private bound(session: Session | undefined, id: string) {
    const binding = session?.bindings.get(id);
    const bridge = session?.bridge;
    if (!session || !bridge || !binding || binding.instance !== bridge.instanceId)
      throw new ComputerUseError("binding_not_found");
    this.check(session);
    return { active: session, binding, bridge };
  }

  private async changeBinding<T>(session: Session, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      // A late bind or unbind can leave native state that the host cannot address.
      if (errorCode(cause) === "request_timeout") this.remove(session);
      throw cause;
    }
  }

  private cancel(session: Session | undefined): Promise<StopResult> {
    if (!session) return Promise.resolve(stopConfirmed);
    if (session.stopped) return Promise.resolve(session.stopped);
    if (session.stop) return session.stop;
    const bridge = session.bridge;
    session.bindings.clear();
    session.timer ??= setTimeout(() => this.remove(session), this.deps.sessionTtlMs).unref();
    session.stop = bridge ? this.stopHelper(session, bridge) : Promise.resolve(stopConfirmed);
    if (!bridge) {
      session.stopped = stopConfirmed;
      session.launch.abort();
      this.releaseWindows(session);
    }
    return session.stop;
  }

  private async stopHelper(session: Session, bridge: Bridge): Promise<StopResult> {
    try {
      const result = await bridge.cancel({ timeoutMs: STOP_TIMEOUT_MS });
      if (result.stop === "cancel_requested") void this.confirmStop(session, bridge, result);
      else this.finishStop(session, bridge, result);
      return result;
    } catch {
      this.finishStop(session, bridge, stopRequested);
      return stopRequested;
    }
  }

  private async confirmStop(
    session: Session,
    bridge: Bridge,
    requested: StopResult,
  ): Promise<void> {
    const signal = AbortSignal.any([AbortSignal.timeout(STOP_TIMEOUT_MS), session.launch.signal]);
    try {
      while (!signal.aborted) {
        await delay(50, undefined, { signal, ref: false });
        const status = await bridge.status({ signal });
        if (status.stop === "stop_confirmed") {
          this.finishStop(session, bridge, { stop: status.stop, reason: status.reason });
          return;
        }
      }
    } catch {}
    this.finishStop(session, bridge, requested);
  }

  private finishStop(session: Session, bridge: Bridge, result: StopResult): void {
    session.stopped = result;
    bridge.close();
    this.releaseWindows(session);
  }

  private releaseBinding(session: Session, id: string): void {
    const binding = session.bindings.get(id);
    if (!binding) return;
    session.bindings.delete(id);
    this.windows.delete(binding.window);
  }

  private releaseWindows(session: Session): void {
    for (const [window, owner] of this.windows) if (owner === session) this.windows.delete(window);
  }

  private remove(session: Session): void {
    if (this.sessions.get(session.peer) !== session) return;
    this.sessions.delete(session.peer);
    clearTimeout(session.timer);
    session.bindings.clear();
    session.launch.abort();
    session.bridge?.close();
    this.releaseWindows(session);
  }
}
