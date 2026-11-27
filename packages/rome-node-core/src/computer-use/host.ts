import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { actionError, isRecord, type ActionResponse, type BinaryActionResult } from "../actions.js";
import { isUuid } from "../frame.js";
import { ComputerUseBridge } from "./bridge.js";
import { discoverHelper } from "./discovery.js";
import { probeHelperPermissions } from "./launch.js";
import {
  ComputerUseError,
  JSON_LIMIT,
  PNG_LIMIT,
  requestParams,
  type Results,
  type HelperAccess,
  type MissingPermission,
} from "./protocol.js";

const CONSENT_TTL_MS = 180_000;
// The helper can still be opening the permission guide after a timely Allow.
const CONSENT_REPLY_GRACE_MS = 10_000;
const SYSTEM_PERMISSION_TTL_MS = 300_000;
const TERMINAL_TTL_MS = 600_000;
const MAX_TERMINALS_PER_PEER = 64;
const SESSION_TTL_MS = 5 * 60_000;
const PERMISSION_TTL_MS = 30_000;
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

function validAccessArgs(args: unknown): boolean {
  return args === undefined || (isRecord(args) && !Object.keys(args).length);
}

function errorCode(cause: unknown): ComputerUseError["code"] {
  return cause instanceof ComputerUseError ? cause.code : "internal_error";
}

const errorMessages: Partial<Record<ComputerUseError["code"], string>> = {
  computer_use_unsupported_platform: "The Computer Use Helper requires macOS.",
  computer_use_helper_missing: "The Computer Use Helper is missing from this Mac.",
  action_outcome_unknown:
    "The Helper did not confirm the input outcome. Do not retry with a new action ID.",
  window_focus_unavailable:
    "Keyboard input requires the bound window to have focus within its app. Focus that window before sending keys, or use an Accessibility action such as set_value or press.",
};

type Bridge = Pick<
  ComputerUseBridge,
  | "initialAccess"
  | "accessStatus"
  | "openPermissionGuide"
  | "instanceId"
  | "helperPid"
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
  | "onCancelRequested"
>;

interface HostDeps {
  bundledAppPath?: string;
  discover: typeof discoverHelper;
  probePermissions: typeof probeHelperPermissions;
  launch: (options: Parameters<typeof ComputerUseBridge.launch>[0]) => Promise<Bridge>;
  consentTtlMs: number;
  permissionTtlMs: number;
  terminalTtlMs: number;
  sessionTtlMs: number;
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
  stopPollMs: number;
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

type TerminalStatus = "consent_denied" | "consent_expired" | "permissions_expired" | "cancelled";
type Phase = { status: "pending_consent" } | HelperAccess;

interface TerminalRecord {
  status: TerminalStatus;
  requestId: string;
  revision: number;
  missing?: MissingPermission[];
  reason?: ComputerUseError["code"];
}

interface Session {
  requestId: string;
  replaces?: string;
  revision: number;
  phase?: Phase;
  refocusing?: Promise<void>;
  peer: string;
  launch: AbortController;
  bindings: Map<string, Binding>;
  pending: number;
  working: boolean;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  appPath?: string;
  bridge?: Bridge;
  cancelRevision: number;
  stop?: Promise<StopResult>;
  stopped?: StopResult;
}

interface Operation {
  usage: string;
  urgent?: true;
  run: (
    session: Session | undefined,
    args: unknown,
    binary: boolean,
    peer: string,
  ) => Promise<BinaryActionResult>;
}

interface PreparedOperation {
  run(refusal?: ActionResponse): Promise<BinaryActionResult>;
  release(): void;
}

export class ComputerUseHost {
  private readonly sessions = new Map<string, Session>();
  private readonly history = new Map<string, Map<string, TerminalRecord>>();
  private readonly windows = new Map<number, Session>();
  private readonly deps: HostDeps;
  private readonly permissionProbes = new Map<
    string,
    { result: Promise<boolean | undefined>; expiresAt: number }
  >();
  private discovering?: Promise<string>;

  constructor(deps: Partial<HostDeps> = {}) {
    this.deps = {
      discover: discoverHelper,
      probePermissions: probeHelperPermissions,
      launch: (options) => ComputerUseBridge.launch(options),
      consentTtlMs: CONSENT_TTL_MS,
      permissionTtlMs: SYSTEM_PERMISSION_TTL_MS,
      terminalTtlMs: TERMINAL_TTL_MS,
      sessionTtlMs: SESSION_TTL_MS,
      now: () => performance.now(),
      isProcessAlive: (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch (cause) {
          return (cause as NodeJS.ErrnoException).code === "EPERM";
        }
      },
      stopPollMs: 200,
      ...deps,
    };
  }

  private readonly operations = {
    "computer.request_access": {
      usage: "No arguments. Request local approval and return the request ID and current state.",
      run: async (session) => {
        if (!session) throw new ComputerUseError("busy");
        if (!session.phase) {
          if ((this.history.get(session.peer)?.size ?? 0) >= MAX_TERMINALS_PER_PEER)
            throw new ComputerUseError("busy");
          const appPath = await this.findHelper();
          this.check(session);
          // Concurrent requests share discovery. Only the first continuation launches.
          if (!session.phase) {
            session.phase = { status: "pending_consent" };
            this.deadline(session, this.deps.consentTtlMs + CONSENT_REPLY_GRACE_MS);
            void this.start(session, appPath);
          }
        } else if (session.phase.status === "needs_system_permission" && !session.refocusing) {
          session.refocusing = session
            .bridge!.openPermissionGuide()
            .then(
              (access) => {
                if (session.phase?.status === "needs_system_permission")
                  this.updateAccess(session, access);
              },
              () => {},
            )
            .finally(() => {
              session.refocusing = undefined;
            });
        }
        return success(this.snapshot(session));
      },
    },
    "computer.status": {
      usage: "{requestId?}. Read the active request or a retained outcome for this peer.",
      run: async (_session, input, _binary, peer) => {
        if (
          input !== undefined &&
          (!isRecord(input) ||
            Object.keys(input).some((key) => key !== "requestId") ||
            (input.requestId !== undefined && typeof input.requestId !== "string"))
        )
          throw new ComputerUseError("invalid_request");
        const requestId = isRecord(input) ? (input.requestId as string | undefined) : undefined;
        const active = this.sessions.get(peer);
        if (active?.phase && (requestId === undefined || requestId === active.requestId)) {
          if (this.deps.now() < active.expiresAt) return success(this.snapshot(active));
          if (requestId !== undefined) return success(this.outcome(active, this.expiry(active)));
        }
        return success(
          requestId === undefined
            ? { status: "idle" }
            : (this.history.get(peer)?.get(requestId) ?? { status: "not_found", requestId }),
        );
      },
    },
    "computer.windows": {
      usage: "{application?}. List windows, optionally filtered by application.",
      run: async (session, input) => {
        const args = requestParams("windows", input);
        const active = this.requireSession(session);
        return this.work(active, async (bridge) => {
          const result = await bridge.windows(args?.application);
          this.check(active);
          return success(result);
        });
      },
    },
    "computer.bind": {
      usage: "{window}. Bind a window by its numeric ID.",
      run: async (session, input) => {
        const { window } = requestParams("bind", input);
        return this.bind(this.requireSession(session), window);
      },
    },
    "computer.unbind": {
      usage: "{binding}. Release the binding.",
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
      usage:
        "{binding, element?, screenshot?}. Read the AX tree, optionally rooted at an element ref. " +
        "screenshot: true requires a binary request frame and returns raw PNG bytes in the response body.",
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
      usage:
        "{binding, actionId, action, ...}. Use a new UUID actionId per intended action. " +
        "For AX, use {element, action: press|increment|decrement} or {element, action: set_value, value}. " +
        "Use an element ref from observe. value is a string, number, or boolean. " +
        "Input fields by action are click {x, y, button?, clickCount?}, move {x, y}, " +
        "drag {x, y, toX, toY, button?, steps?}, scroll {x, y, deltaX, deltaY}, key_press {key}, " +
        "and type_text {text}. Pointer coordinates use points from the window's top-left corner. " +
        "button is left, right, or middle. clickCount is 1 to 3 and steps is 1 to 60. " +
        "key is a named key such as Enter or a single grapheme. Each input action except type_text " +
        "accepts an optional modifiers array of distinct names (command, control, option, shift).",
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
      usage: "No arguments. Stop input for this peer and return the stop status.",
      urgent: true,
      run: async (session) => success(await this.cancel(session)),
    },
  } satisfies Record<string, Operation>;

  async info(peer: string) {
    if (isUuid(peer)) peer = peer.toLowerCase();
    const appPath = await this.findHelper().catch(() => undefined);
    const permitted =
      appPath && !this.sessions.get(peer)?.stop ? await this.permissions(appPath) : undefined;
    const session = this.sessions.get(peer);
    const stopped = Boolean(session?.stop);
    const live = session?.phase?.status === "authorized" && !session.bridge?.closed;
    const installed = Boolean(appPath) || live;
    const state = stopped || !installed ? "off" : (permitted ?? live) ? "on" : "needs_permission";
    const operations = Object.entries<Operation>(this.operations);
    const advertised = installed
      ? operations.filter(
          ([name, operation]) =>
            !stopped ||
            operation.urgent ||
            name === "computer.request_access" ||
            name === "computer.status",
        )
      : [];
    return {
      capability: {
        id: "computer_use",
        prefix: "computer",
        title: "Window Control",
        state,
        personal: true,
        actions: Object.keys(this.operations),
      },
      actions: advertised.map(([action]) => action),
      usage: Object.fromEntries(advertised.map(([action, { usage }]) => [action, usage])),
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
    let session = action === "computer.status" ? undefined : this.sessions.get(peer);
    if (session?.phase && this.deps.now() >= session.expiresAt) {
      this.expire(session);
      session = undefined;
    }
    const requesting = action === "computer.request_access";
    const restarting = requesting && session?.stop ? session : undefined;
    const cancelRevision = restarting?.cancelRevision;
    if (restarting) session = undefined;
    else if (
      !session &&
      ((requesting && !body?.byteLength && validAccessArgs(args)) || operation.urgent)
    )
      session = this.reserve(peer, !!operation.urgent);
    const gate =
      action === "computer.windows" || action === "computer.bind"
        ? this.refusal(session)
        : undefined;
    if (session) session.pending++;
    // Stop bypasses both audit I/O and ordinary request validation.
    const stopping = operation.urgent
      ? operation.run(session, args, body !== undefined, peer)
      : undefined;
    const run = async (refusal?: ActionResponse) => {
      try {
        if (stopping) return await stopping;
        if (refusal) return { response: refusal, body: empty };
        if (body?.byteLength)
          return failure("invalid_request", "Computer Use takes no binary input.");
        if (requesting && !validAccessArgs(args)) return failure("invalid_request");
        if (gate) return gate;
        if (restarting) {
          // A later cancel wins even if it confirmed the same stop during audit.
          if (restarting.cancelRevision !== cancelRevision)
            throw new ComputerUseError("session_stopped");
          const current = this.sessions.get(peer);
          if (current === restarting) {
            if (current.stopped?.stop !== "stop_confirmed")
              throw new ComputerUseError("session_stopped");
            session = this.reserve(peer, false, current);
          } else if (current?.replaces === restarting.requestId) {
            session = current;
          } else throw new ComputerUseError("connection_closed");
          if (session) session.pending++;
        }
        if (session) this.check(session);
        const result = await operation.run(session, args, body !== undefined, peer);
        if (Buffer.byteLength(JSON.stringify(result.response)) > JSON_LIMIT)
          return failure("output_too_large");
        return result;
      } catch (cause) {
        const code = errorCode(cause);
        if (
          session?.appPath &&
          (code === "accessibility_permission_required" ||
            code === "screen_recording_permission_required")
        )
          this.permissionProbes.delete(session.appPath);
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
        if (!session || --session.pending || session.phase || session.stop) return;
        this.remove(session);
      },
    };
  }

  disconnect(): void {
    this.permissionProbes.clear();
    for (const session of this.sessions.values()) this.remove(session);
  }

  private reserve(peer: string, urgent: boolean, previous?: Session): Session | undefined {
    const occupied = urgent
      ? this.sessions.size
      : [...this.sessions.values()].filter((s) => !s.stopped).length;
    if (occupied >= MAX_PEERS) return;
    if (previous) this.remove(previous);
    const session: Session = {
      peer,
      requestId: randomUUID(),
      replaces: previous?.requestId,
      revision: 1,
      cancelRevision: 0,
      launch: new AbortController(),
      bindings: new Map(),
      pending: 0,
      working: false,
      expiresAt: Infinity,
    };
    this.sessions.set(peer, session);
    return session;
  }

  private findHelper(): Promise<string> {
    this.discovering ??= this.deps
      .discover({ bundledAppPath: this.deps.bundledAppPath })
      .finally(() => {
        this.discovering = undefined;
      });
    return this.discovering;
  }

  private permissions(appPath: string): Promise<boolean | undefined> {
    const existing = this.permissionProbes.get(appPath);
    if (existing && this.deps.now() < existing.expiresAt) return existing.result;
    // Older helpers have no permission probe. Keep their session-based status.
    const checking = {
      result: this.deps.probePermissions(appPath).catch(() => undefined),
      expiresAt: Infinity,
    };
    // An invalidated probe may finish for existing callers without replacing the current entry.
    void checking.result.then(() => {
      checking.expiresAt = this.deps.now() + PERMISSION_TTL_MS;
    });
    this.permissionProbes.set(appPath, checking);
    return checking.result;
  }

  private requireSession(session: Session | undefined): Session {
    if (!session || session.phase?.status !== "authorized")
      throw new ComputerUseError("consent_required");
    return session;
  }

  private check(session: Session): void {
    if (session.stop) throw new ComputerUseError("session_stopped");
    if (this.sessions.get(session.peer) !== session)
      throw new ComputerUseError("connection_closed");
    if (this.deps.now() >= session.expiresAt) {
      this.expire(session);
      throw new ComputerUseError("binding_not_found");
    }
  }

  private async work<T>(session: Session, run: (bridge: Bridge) => Promise<T>): Promise<T> {
    this.check(session);
    const bridge = session.bridge;
    if (session.phase?.status !== "authorized" || !bridge || bridge.closed)
      throw new ComputerUseError("consent_required");
    if (session.working) throw new ComputerUseError("busy");
    session.working = true;
    try {
      return await run(bridge);
    } finally {
      session.working = false;
    }
  }

  private snapshot(session: Session) {
    const phase = session.phase!;
    const displayExpiresAt =
      phase.status === "pending_consent"
        ? session.expiresAt - CONSENT_REPLY_GRACE_MS
        : session.expiresAt;
    return {
      ...phase,
      requestId: session.requestId,
      revision: session.revision,
      expiresInMs: Math.max(0, Math.ceil(displayExpiresAt - this.deps.now())),
    };
  }

  private refusal(session?: Session): BinaryActionResult | undefined {
    if (!session?.phase) return failure("consent_required");
    if (session.phase.status === "authorized") return;
    const { status, ...details } = this.snapshot(session);
    return { response: actionError(status, status, details), body: empty };
  }

  private deadline(session: Session, ms: number) {
    clearTimeout(session.timer);
    session.expiresAt = this.deps.now() + ms;
    session.timer = setTimeout(() => this.expire(session), ms).unref();
  }

  private expiry(session: Session): TerminalStatus {
    switch (session.phase?.status) {
      case "pending_consent":
        return "consent_expired";
      case "needs_system_permission":
        return "permissions_expired";
      default:
        return "cancelled";
    }
  }

  private expire(session: Session) {
    this.remove(session, this.expiry(session));
  }

  private async start(session: Session, appPath: string) {
    try {
      session.appPath = appPath;
      this.permissionProbes.delete(appPath);
      const bridge = await this.deps.launch({
        appPath,
        signal: session.launch.signal,
        startupTimeoutMs: 8000,
        consentMode: "session_only",
        includeAccess: true,
        consentTimeoutMs: this.deps.consentTtlMs + 15_000,
        consentDialogTimeoutMs: this.deps.consentTtlMs,
      });
      // Cancellation can win while LaunchServices or the consent handshake is outstanding.
      if (!this.current(session)) {
        bridge.close();
        return;
      }
      session.bridge = bridge;
      bridge.onDisconnect((cause) => {
        this.permissionProbes.delete(appPath);
        if (session.stop)
          this.finishStop(
            session,
            bridge,
            cause.code === "session_stopped" ? stopConfirmed : stopRequested,
          );
        else this.failed(session, cause);
      });
      bridge.onCancelRequested(() => {
        if (!this.current(session)) return;
        this.seal(session);
        session.stop = Promise.resolve(stopRequested);
      });
      let access = bridge.initialAccess;
      if (!access) throw new ComputerUseError("method_unavailable");
      while (this.current(session)) {
        this.updateAccess(session, access);
        if (!this.current(session)) return;
        const next = await bridge.accessStatus(access.revision, {
          timeoutMs: Math.ceil(session.expiresAt - this.deps.now()) + 15_000,
          signal: session.launch.signal,
        });
        if (next.revision <= access.revision) throw new ComputerUseError("invalid_frame");
        access = next;
      }
    } catch (cause) {
      this.failed(session, cause);
    }
  }

  private current(session: Session) {
    return this.sessions.get(session.peer) === session && !session.stop && !!session.phase;
  }

  private updateAccess(session: Session, access: HelperAccess) {
    if (!this.current(session)) return;
    if (this.deps.now() >= session.expiresAt) {
      this.expire(session);
      return;
    }
    const previous = session.phase!;
    if (previous.status !== "pending_consent" && access.revision <= previous.revision) return;
    session.phase = access;
    session.revision++;
    if (session.appPath) this.permissionProbes.delete(session.appPath);
    if (access.status !== previous.status)
      this.deadline(
        session,
        access.status === "authorized" ? this.deps.sessionTtlMs : this.deps.permissionTtlMs,
      );
  }

  private failed(session: Session, cause: unknown) {
    if (!this.current(session)) return;
    const code = errorCode(cause);
    if (code === "session_stopped") {
      this.record(session, "cancelled");
      session.stop = Promise.resolve(stopConfirmed);
      session.stopped = stopConfirmed;
      session.bindings.clear();
      session.launch.abort();
      session.bridge?.close();
      this.releaseWindows(session);
      this.scheduleStopCleanup(session);
      return;
    }
    this.remove(
      session,
      code === "consent_denied" ||
        code === "consent_expired" ||
        (code === "permissions_expired" && session.phase?.status === "needs_system_permission")
        ? code
        : "cancelled",
      code === "cancelled" || code === "request_aborted" ? undefined : code,
    );
  }

  private async bind(session: Session, window: number): Promise<BinaryActionResult> {
    return this.work(session, async (bridge) => {
      if (this.windows.has(window)) throw new ComputerUseError("window_already_bound");
      if (session.bindings.size >= MAX_BINDINGS) throw new ComputerUseError("busy");
      this.windows.set(window, session);
      try {
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
          bindingTTLms: Math.max(0, Math.floor(session.expiresAt - this.deps.now())),
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
      if (!session.stop && errorCode(cause) === "request_timeout") this.remove(session);
      throw cause;
    }
  }

  private cancel(session: Session | undefined): Promise<StopResult> {
    if (!session) return Promise.resolve(stopConfirmed);
    session.cancelRevision++;
    if (session.stopped) return Promise.resolve(session.stopped);
    if (session.stop) return session.stop;
    const waiting = session.phase?.status !== "authorized";
    const bridge = session.bridge;
    this.seal(session);
    session.stop =
      bridge && !waiting ? this.stopHelper(session, bridge) : Promise.resolve(stopConfirmed);
    if (!bridge || waiting) {
      bridge?.close();
      session.stopped = stopConfirmed;
      session.launch.abort();
      this.releaseWindows(session);
      this.scheduleStopCleanup(session);
    }
    return session.stop;
  }

  private seal(session: Session): void {
    if (session.appPath) this.permissionProbes.delete(session.appPath);
    this.record(session, "cancelled");
    session.bindings.clear();
    clearTimeout(session.timer);
    session.timer = undefined;
  }

  private scheduleStopCleanup(session: Session): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.remove(session), this.deps.sessionTtlMs).unref();
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
    if (this.sessions.get(session.peer) !== session || session.stopped?.stop === "stop_confirmed")
      return;
    session.stopped = result;
    bridge.close();
    if (result.stop === "stop_confirmed") {
      this.releaseWindows(session);
      this.scheduleStopCleanup(session);
    } else {
      this.watchHelperExit(session, bridge);
    }
  }

  private watchHelperExit(session: Session, bridge: Bridge): void {
    if (session.timer) return;
    session.timer = setTimeout(() => {
      session.timer = undefined;
      if (this.sessions.get(session.peer) !== session || session.stopped?.stop === "stop_confirmed")
        return;
      if (bridge.helperPid > 0 && this.deps.isProcessAlive(bridge.helperPid))
        this.watchHelperExit(session, bridge);
      else this.finishStop(session, bridge, stopConfirmed);
    }, this.deps.stopPollMs).unref();
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

  private outcome(session: Session, status: TerminalStatus): TerminalRecord {
    return {
      status,
      revision: session.revision + 1,
      requestId: session.requestId,
      ...(status === "permissions_expired" &&
        session.phase?.status === "needs_system_permission" && { missing: session.phase.missing }),
    };
  }

  private record(session: Session, status: TerminalStatus, reason?: TerminalRecord["reason"]) {
    if (!session.phase) return;
    const record = this.outcome(
      session,
      this.deps.now() >= session.expiresAt ? this.expiry(session) : status,
    );
    session.revision = record.revision;
    if (reason && record.status === "cancelled") record.reason = reason;
    session.phase = undefined;
    const records = this.history.get(session.peer) ?? new Map<string, TerminalRecord>();
    this.history.set(session.peer, records);
    records.set(record.requestId, record);
    const peer = session.peer;
    setTimeout(() => {
      records.delete(record.requestId);
      if (!records.size) this.history.delete(peer);
    }, this.deps.terminalTtlMs).unref();
  }

  private remove(
    session: Session,
    outcome: TerminalStatus = "cancelled",
    reason?: TerminalRecord["reason"],
  ): void {
    if (this.sessions.get(session.peer) !== session) return;
    this.record(session, outcome, reason);
    this.sessions.delete(session.peer);
    clearTimeout(session.timer);
    session.bindings.clear();
    session.launch.abort();
    session.bridge?.close();
    this.releaseWindows(session);
  }
}
