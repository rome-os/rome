import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { actionError, isRecord, type ActionResponse, type BinaryActionResult } from "../actions.js";
import { ComputerUseLedger } from "./ledger.js";
import { mergeComputerUseObservation } from "./state.js";
import {
  createComputerUseNativeBridge,
  computerUseAppPath,
  defaultComputerUseStateDir,
  type ComputerUseNative,
  type NativeBridgeOptions,
} from "./native-bridge.js";
import {
  boundedString,
  COMPUTER_USE_ACTIONS,
  computerUseAction,
  ComputerUseError,
  parseComputerUseArgs,
  parseComputerUseHello,
  parseComputerUseObservation,
  parseComputerUseWindowLease,
  sameComputerUseObservationRegion,
  supportsComputerUseEnd,
  type ComputerUseHello,
  type ComputerUseObservation,
  type ComputerUseObservationRegion,
  type ComputerUseStopReceipt,
} from "./protocol.js";

const empty = new Uint8Array();
interface Session {
  peer: string;
  allowedActions: ReadonlySet<string>;
  maxValueLength: number;
  maxTextLength: number;
  partialObservations: boolean;
  observationRegion: boolean;
  windowSemantics: boolean;
  supportsEnd: boolean;
  supportsRecovery: boolean;
  leased: boolean;
  terminal?: string;
  stopping: boolean;
  endWork?: Promise<ComputerUseStopReceipt>;
  endReceipt?: ComputerUseStopReceipt;
  observation?: ComputerUseObservation;
  state?: ComputerUseObservation;
  observationEpoch: number;
  expiresAt?: number;
  deadline: number;
  leaseDeadline?: number;
  busy: boolean;
  actions: Map<
    string,
    { key: string; outcome: Record<string, unknown>; verification?: Record<string, unknown> }
  >;
}

export interface ComputerUseHostOptions extends NativeBridgeOptions {
  native?: ComputerUseNative;
  platform?: NodeJS.Platform;
  now?: () => number;
  monotonicNow?: () => number;
}
export interface ComputerUseDispatchAuthority {
  allowPreemption?: true;
  leaseIfAvailable?: true;
}
export interface ComputerUseHost {
  describe(): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  requestPermissions(): Promise<ActionResponse>;
  idle(): Promise<void>;
  run(
    action: string,
    args: unknown,
    peer: string,
    authority?: ComputerUseDispatchAuthority,
  ): Promise<ActionResponse>;
  runBinary(
    action: string,
    args: unknown,
    body: Uint8Array,
    peer: string,
    authority?: ComputerUseDispatchAuthority,
  ): Promise<BinaryActionResult>;
  disconnect(): void;
}

function failed(error: unknown, action?: string): ActionResponse {
  return error instanceof ComputerUseError
    ? actionError(
        error.code,
        error.message,
        action === "computer.act" && error.details.effectStatus === undefined
          ? { ...error.details, effectStatus: "not_dispatched" }
          : error.details,
      )
    : actionError("computer_use_failed", "The computer-use operation could not complete.");
}

function nativeTerminal(result: Record<string, unknown>): string | undefined {
  const cause = result.terminalCause;
  if (typeof cause === "string" && cause) return cause;
  if (["cancelled", "takeover", "invalidated", "unknown", "halted"].includes(String(result.status)))
    return String(result.status);
  return undefined;
}

function confirmedStopCause(sessionId: string, value: unknown): string | undefined {
  if (
    isRecord(value) &&
    value.sessionId === sessionId &&
    value.stopConfirmed === true &&
    boundedString(value.terminalCause, 100)
  )
    return value.terminalCause;
  return undefined;
}

function dispatchCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function bindingCapabilities(binding: Record<string, unknown>) {
  const capabilities = binding.capabilities;
  if (
    (binding.scope !== undefined && binding.scope !== "background") ||
    (isRecord(capabilities) && capabilities.realPointer === true)
  )
    throw new ComputerUseError(
      "background_control_required",
      "The helper must bind a background window without using the system pointer.",
    );
  if (
    capabilities !== undefined &&
    (!isRecord(capabilities) ||
      !Array.isArray(capabilities.actions) ||
      capabilities.actions.length > 32 ||
      capabilities.actions.some((action) => !boundedString(action, 128)) ||
      new Set(capabilities.actions).size !== capabilities.actions.length ||
      [capabilities.maxValueLength, capabilities.maxTextLength].some(
        (limit) => limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 0),
      ))
  )
    throw new ComputerUseError(
      "invalid_helper_response",
      "The helper returned invalid background capabilities.",
    );
  const windowDirected =
    isRecord(capabilities) &&
    capabilities.coordinateSpace === "window_image_pixels" &&
    capabilities.realPointer === false;
  const advertised = isRecord(capabilities) ? (capabilities.actions as string[]) : ["setValue"];
  const windowSemantics =
    isRecord(capabilities) && capabilities.inputIsolation === "window_semantics";
  if (
    windowSemantics &&
    (!windowDirected ||
      capabilities.transport !== "ax_only" ||
      advertised.some((action) => !["click", "press", "setValue", "selectText"].includes(action)))
  )
    throw new ComputerUseError(
      "invalid_helper_response",
      "The helper returned unsafe window-semantic capabilities.",
    );
  return {
    allowedActions: new Set(
      windowDirected ? advertised : advertised.filter((action) => action === "setValue"),
    ),
    maxValueLength: windowDirected
      ? Math.min(16384, Number(capabilities.maxValueLength ?? 16384))
      : 180,
    maxTextLength: windowDirected ? Math.min(4096, Number(capabilities.maxTextLength ?? 4096)) : 0,
    partialObservations: windowDirected && capabilities.partialObservations === true,
    observationRegion: windowDirected && capabilities.observationRegion === true,
    windowSemantics,
  };
}

/** The host owns its sessions; the shared native service owns the machine's execution lane. */
export function createComputerUseHost(options: ComputerUseHostOptions = {}): ComputerUseHost {
  const stateDir = options.stateDir ?? defaultComputerUseStateDir();
  const native = options.native ?? createComputerUseNativeBridge({ ...options, stateDir });
  const ledger = new ComputerUseLedger(join(stateDir, "ledger"));
  const sessions = new Map<string, Session>();
  const stopping = new Set<Promise<void>>();
  const now = options.now ?? Date.now;
  const monotonic = options.monotonicNow ?? (() => performance.now());
  const platform = options.platform ?? process.platform;
  const supported =
    platform === "darwin" && (options.native !== undefined || process.arch === "arm64");
  const advertisedActions = [...COMPUTER_USE_ACTIONS];
  let generation = 0;
  let helperEpoch = 0;
  let helperIdentity: string | undefined;
  let checkingHelper: Promise<ComputerUseHello> | undefined;
  let reclaiming: Promise<void> | undefined;
  let opening = 0;
  let laneUnknown = false;

  const describe = async () => {
    const app =
      supported && !options.native
        ? await lstat(computerUseAppPath(options)).catch(() => null)
        : null;
    const configured =
      supported &&
      (Boolean(options.native) || Boolean(app?.isDirectory() && !app.isSymbolicLink()));
    return {
      prefix: "computer",
      personal: true,
      version: 1,
      platform: platform === "darwin" && supported ? "macos" : platform,
      configured,
      actions: configured ? advertisedActions : [],
    };
  };
  async function stop(sessionId: string, session: Session, cause: string): Promise<void> {
    if (session.terminal) return;
    session.stopping = true;
    session.observation = undefined;
    session.state = undefined;
    session.expiresAt = undefined;
    try {
      session.terminal = await ledger.terminal(sessionId, cause);
    } catch {
      session.terminal = "unknown";
      throw new ComputerUseError(
        "computer_ledger_unavailable",
        "The computer-use stop could not be recorded. The session cannot accept more input.",
      );
    }
  }
  async function reclaimSessions(supportsRecovery: boolean): Promise<void> {
    return (reclaiming ??= (async () => {
      const expired: Array<[string, Session]> = [];
      const idle: Array<[string, Session]> = [];
      const now = monotonic();
      for (const [id, session] of sessions) {
        if (session.busy || session.endWork) continue;
        if (session.endReceipt?.stopConfirmed === false && session.deadline > now) continue;
        if (session.terminal) sessions.delete(id);
        else if (session.deadline <= now) {
          // Close admission before cancellation yields to another request.
          session.stopping = true;
          expired.push([id, session]);
        } else if (
          supportsRecovery &&
          session.leaseDeadline !== undefined &&
          session.leaseDeadline <= now
        ) {
          idle.push([id, session]);
        }
      }
      await Promise.allSettled([
        ...expired.map(async ([id, session]) => {
          await stop(id, session, "expired").catch(() => {});
          await native.call("cancel", { sessionId: id, reason: "cancelled" }).catch(() => {});
          if (sessions.get(id) === session && !session.busy) sessions.delete(id);
        }),
        ...idle.map(async ([id, session]) => {
          if (
            (await confirmSessionStop(id, session)) &&
            !session.busy &&
            !session.endWork &&
            sessions.get(id) === session
          )
            sessions.delete(id);
        }),
      ]);
    })().finally(() => {
      reclaiming = undefined;
    }));
  }
  function sessionFor(args: Record<string, unknown>, peer: string): [string, Session] {
    const id = String(args.sessionId);
    const session = sessions.get(id);
    if (!session || session.peer !== peer)
      throw new ComputerUseError(
        "unknown_session",
        "This caller does not own that computer-use session.",
      );
    return [id, session];
  }
  async function adoptTerminal(
    sessionId: string,
    session: Session,
    value: Record<string, unknown>,
  ): Promise<void> {
    const cause = nativeTerminal(value);
    if (cause) await stop(sessionId, session, cause);
  }
  async function recordConfirmedStop(sessionId: string, value: unknown): Promise<void> {
    const cause = confirmedStopCause(sessionId, value);
    if (cause) await ledger.confirmStop(sessionId, cause);
  }
  async function confirmSessionStop(sessionId: string, session: Session) {
    if (session.endReceipt?.stopConfirmed) return session.endReceipt.terminalCause;
    // The host deadline schedules a read. The native lease may have renewed in flight.
    const proof = await native.call("stop_status", { sessionId });
    const cause = confirmedStopCause(sessionId, proof);
    if (!cause || sessions.get(sessionId) !== session) return undefined;
    await stop(sessionId, session, cause);
    await ledger.confirmStop(sessionId, cause);
    session.endReceipt = {
      sessionId,
      terminalCause: cause,
      status: cause,
      stopConfirmed: true,
      effectVerified: false,
    };
    return cause;
  }
  async function endSession(sessionId: string, session: Session): Promise<ComputerUseStopReceipt> {
    if (!session.supportsEnd)
      throw new ComputerUseError(
        "session_end_unsupported",
        "This helper cannot confirm a normal stop. Use computer.cancel for this session.",
      );
    if (session.endReceipt?.stopConfirmed) return { ...session.endReceipt };
    if (session.endWork) return { ...(await session.endWork) };
    session.stopping = true;
    session.observation = undefined;
    session.state = undefined;
    session.expiresAt = undefined;
    session.endWork = (async (): Promise<ComputerUseStopReceipt> => {
      try {
        const value = await native.call("end", { sessionId });
        if (
          !isRecord(value) ||
          value.sessionId !== sessionId ||
          !boundedString(value.terminalCause, 100) ||
          typeof value.stopConfirmed !== "boolean"
        )
          throw new ComputerUseError(
            "invalid_helper_response",
            "The helper returned an invalid stop receipt.",
          );
        await stop(sessionId, session, value.terminalCause);
        await recordConfirmedStop(sessionId, value);
        const terminalCause = session.terminal ?? "unknown";
        return {
          sessionId,
          terminalCause,
          status: value.stopConfirmed ? terminalCause : "stop_pending",
          stopConfirmed: value.stopConfirmed,
          effectVerified: false,
        };
      } catch {
        // A later end can query the same stop without dispatching input.
        return {
          sessionId,
          status: "stop_pending",
          terminalCause: session.terminal ?? "unknown",
          stopConfirmed: false,
          effectVerified: false,
        };
      }
    })()
      .then((receipt) => {
        if (session.endReceipt?.stopConfirmed) return { ...session.endReceipt };
        session.endReceipt = { ...receipt };
        return receipt;
      })
      .finally(() => {
        session.endWork = undefined;
      });
    return session.endWork;
  }
  async function confirmErrorStop(args: unknown, peer: string, error: unknown): Promise<unknown> {
    if (
      !isRecord(args) ||
      typeof args.sessionId !== "string" ||
      !(error instanceof ComputerUseError)
    )
      return error;
    const session = sessions.get(args.sessionId);
    if (!session || session.peer !== peer) return error;
    const cause = boundedString(error.details.terminalCause, 100)
      ? error.details.terminalCause
      : ["session_stopped", "session_expired", "session_not_found"].includes(error.code)
        ? "invalidated"
        : undefined;
    if (cause && cause !== "stop_pending")
      await stop(args.sessionId, session, cause).catch(() => {});
    if (
      !["stale_observation", "session_stopped", "session_expired", "session_not_found"].includes(
        error.code,
      ) ||
      !session.supportsRecovery ||
      session.leaseDeadline === undefined ||
      monotonic() < session.leaseDeadline
    )
      return error;
    const stopped = await confirmSessionStop(args.sessionId, session).catch(() => undefined);
    if (!stopped) return error;
    return new ComputerUseError(
      error.code,
      "The old session is confirmed stopped. List and bind the same approved window, then observe again before any new action. Never replay an unknown outcome.",
      { ...error.details, terminalCause: stopped, stopConfirmed: true },
    );
  }
  async function hello(clearUnknown = false): Promise<ComputerUseHello> {
    // Coalescing keeps an older hello from restoring a superseded helper identity.
    const value = await (checkingHelper ??= (async () => {
      const current = parseComputerUseHello(await native.call("hello", {}));
      const identity =
        current.instanceId ?? (current.pid === undefined ? undefined : `pid:${current.pid}`);
      if (identity !== undefined) {
        const restarted = helperIdentity !== undefined && identity !== helperIdentity;
        helperIdentity = identity;
        if (restarted) {
          helperEpoch++;
          await Promise.all(
            [...sessions].map(([id, session]) => stop(id, session, "helper_restarted")),
          );
          if (isRecord(current.execution) && current.execution.busy === false) laneUnknown = false;
        }
      }
      return current;
    })().finally(() => {
      checkingHelper = undefined;
    })).catch((error: unknown) => {
      throw new ComputerUseError(
        error instanceof ComputerUseError ? error.code : "helper_status_failed",
        error instanceof ComputerUseError
          ? error.message
          : "The helper identity could not be checked.",
        {
          ...(error instanceof ComputerUseError ? error.details : {}),
          effectStatus: "not_dispatched",
        },
      );
    });
    if (clearUnknown && isRecord(value.execution) && value.execution.busy === false)
      laneUnknown = false;
    return value;
  }
  async function perform(
    action: string,
    raw: unknown,
    peer: string,
    binary: boolean,
    authority?: ComputerUseDispatchAuthority,
  ): Promise<BinaryActionResult> {
    const admittedGeneration = generation;
    if (!supported)
      throw new ComputerUseError(
        "unsupported_platform",
        "Native computer use requires an Apple Silicon Mac.",
      );
    if (!boundedString(peer))
      throw new ComputerUseError(
        "invalid_caller",
        "Computer use requires an authenticated caller.",
      );
    if (!computerUseAction(action))
      throw new ComputerUseError(
        "unsupported_action",
        "This computer-use action is not supported.",
      );
    const args = parseComputerUseArgs(action, raw);
    if (action === "computer.preempt" && authority?.allowPreemption !== true)
      throw new ComputerUseError(
        "preemption_denied",
        "This request does not authorize replacing an active window session.",
        { effectStatus: "not_dispatched" },
      );
    let result: unknown;
    let body = empty;
    if (action === "computer.status") result = await hello(true);
    else if (action === "computer.windows") {
      const { background } = (await hello()).capabilities;
      result = await native.call("windows", {});
      if (
        !isRecord(result) ||
        !Array.isArray(result.windows) ||
        result.windows.length > 512 ||
        !result.windows.every((window) => isRecord(window) && boundedString(window.windowRef))
      )
        throw new ComputerUseError(
          "invalid_helper_response",
          "The computer-use helper returned an invalid window list.",
        );
      if (isRecord(background) && background.foregroundNavigationFallback === true) {
        result = {
          ...result,
          windows: result.windows.map((window) =>
            isRecord(window.capabilities) &&
            window.capabilities.inputIsolation === "background_application"
              ? {
                  ...window,
                  capabilities: { ...window.capabilities, foregroundNavigationFallback: true },
                }
              : window,
          ),
        };
      }
    } else if (action === "computer.recover") {
      const actionId = String(args.actionId);
      let recovered = await ledger.recover(peer, actionId);
      if (!recovered)
        throw new ComputerUseError(
          "unknown_action",
          "This caller has no durable record for that action.",
        );
      if (!recovered.stopConfirmed) {
        const sessionId = recovered.sessionId;
        const value = await (native.readStopStatus
          ? native.readStopStatus(sessionId)
          : (async () => {
              const background = parseComputerUseHello(await native.call("hello", {})).capabilities
                .background;
              if (!isRecord(background) || background.sessionRecovery !== true) return undefined;
              return native.call("stop_status", { sessionId });
            })()
        ).catch(() => undefined);
        if (value !== undefined) {
          await recordConfirmedStop(recovered.sessionId, value);
          recovered = (await ledger.recover(peer, actionId)) ?? recovered;
        }
      }
      result = { ...recovered, stopConfirmed: recovered.stopConfirmed === true };
    } else if (action === "computer.bind" || action === "computer.preempt") {
      const capabilitiesReport = await hello();
      const supportsEnd = supportsComputerUseEnd(capabilitiesReport);
      const background = capabilitiesReport.capabilities.background;
      const preempting = action === "computer.preempt";
      if (preempting && (!isRecord(background) || background.windowPreemption !== true))
        throw new ComputerUseError(
          "preemption_unsupported",
          "This helper cannot replace a window binding.",
        );
      const supportsLease = isRecord(background) && background.windowLease === true;
      const foregroundNavigationFallback =
        args.foregroundNavigationFallback === true &&
        isRecord(background) &&
        background.foregroundNavigationFallback === true;
      const leased = args.lease === true || (authority?.leaseIfAvailable === true && supportsLease);
      if (leased && !supportsLease)
        throw new ComputerUseError(
          "window_lease_unsupported",
          "The helper does not advertise renewable window leases.",
        );
      if (args.requireSessionEnd === true && !supportsEnd)
        throw new ComputerUseError(
          "session_end_unsupported",
          "This helper cannot confirm a normal stop. No window was bound.",
        );
      const bindingEpoch = helperEpoch;
      if (sessions.size + opening >= 128)
        await reclaimSessions(isRecord(background) && background.sessionRecovery === true);
      if (sessions.size + opening >= 128)
        throw new ComputerUseError("busy", "Close an existing computer-use session first.");
      if (admittedGeneration !== generation || bindingEpoch !== helperEpoch)
        throw new ComputerUseError("computer_host_stopped", "The host stopped before binding.");
      opening++;
      try {
        const sessionId = randomBytes(24).toString("base64url");
        let binding: unknown;
        try {
          binding = await native.call(preempting ? "preempt" : "bind", {
            windowRef: args.windowRef,
            sessionId,
            ...(foregroundNavigationFallback ? { foregroundNavigationFallback: true } : {}),
            ...(leased ? { lease: true } : {}),
            ...(preempting ? { preemptToken: args.preemptToken } : {}),
          });
        } catch (error) {
          if (
            !(error instanceof ComputerUseError && error.details.effectStatus === "not_dispatched")
          ) {
            await native.call("cancel", { sessionId, reason: "host_stopped" }).catch(() => {});
          }
          throw error;
        }
        let capabilities: ReturnType<typeof bindingCapabilities>;
        let bindingSupportsEnd: boolean;
        let leaseDeadline: number | undefined;
        try {
          if (!isRecord(binding) || binding.sessionId !== sessionId)
            throw new ComputerUseError(
              "invalid_helper_response",
              "The computer-use helper returned an invalid session binding.",
            );
          capabilities = bindingCapabilities(binding);
          if (
            isRecord(binding.capabilities) &&
            binding.capabilities.foregroundNavigationFallback === true &&
            !foregroundNavigationFallback
          )
            throw new ComputerUseError(
              "binding_capability_mismatch",
              "The helper enabled foreground interaction outside the requested binding.",
            );
          if (
            preempting &&
            (!isRecord(binding.capabilities) ||
              binding.capabilities.windowPreemption !== true ||
              !boundedString(binding.preemptedSessionId, 128) ||
              binding.preemptedSessionId === sessionId ||
              !isRecord(binding.preemption) ||
              binding.preemption.stopConfirmed !== true ||
              !boundedString(binding.preemption.terminalCause, 100))
          )
            throw new ComputerUseError(
              "invalid_helper_response",
              "The replacement binding did not confirm the previous stop.",
            );
          bindingSupportsEnd =
            supportsEnd &&
            isRecord(binding.capabilities) &&
            binding.capabilities.sessionEnd === true;
          if (args.requireSessionEnd === true && !bindingSupportsEnd)
            throw new ComputerUseError(
              "session_end_unsupported",
              "The bound helper did not confirm normal stop support. No input was dispatched.",
            );
          if (leased) {
            if (!isRecord(binding.capabilities) || binding.capabilities.windowLease !== true)
              throw new ComputerUseError(
                "window_lease_unsupported",
                "The bound helper did not confirm renewable window leases.",
              );
            leaseDeadline = monotonic() + parseComputerUseWindowLease(binding.lease).remainingMs;
          }
        } catch (error) {
          await native.call("cancel", { sessionId, reason: "host_stopped" }).catch(() => {});
          throw error;
        }
        if (admittedGeneration !== generation || bindingEpoch !== helperEpoch) {
          await native.call("cancel", { sessionId, reason: "connection_lost" }).catch(() => {});
          throw new ComputerUseError(
            "computer_host_stopped",
            "The host stopped before the session was bound.",
          );
        }
        sessions.set(sessionId, {
          peer,
          ...capabilities,
          supportsEnd: bindingSupportsEnd,
          supportsRecovery: isRecord(background) && background.sessionRecovery === true,
          leased,
          leaseDeadline,
          stopping: false,
          busy: false,
          deadline:
            monotonic() +
            (typeof binding.expiresAt === "number" && Number.isFinite(binding.expiresAt)
              ? Math.max(0, Math.min(600, binding.expiresAt - now() / 1000)) * 1000
              : 600_000),
          observationEpoch: 0,
          actions: new Map(),
        });
        if (isRecord(binding) && preempting) {
          const { preemptedSessionId, ...publicBinding } = binding;
          if (
            boundedString(preemptedSessionId, 128) &&
            isRecord(binding.preemption) &&
            boundedString(binding.preemption.terminalCause, 100)
          ) {
            const prior = sessions.get(preemptedSessionId);
            const cause = binding.preemption.terminalCause;
            if (prior) await stop(preemptedSessionId, prior, cause).catch(() => {});
            await ledger.confirmStop(preemptedSessionId, cause).catch(() => {});
          }
          result = publicBinding;
        } else result = binding;
      } finally {
        opening--;
      }
    } else {
      const [sessionId, session] = sessionFor(args, peer);
      if (action === "computer.end") {
        result = await endSession(sessionId, session);
        return { response: { type: "response", ok: true, result }, body };
      }
      if (action !== "computer.cancel" && !session.terminal && !session.stopping) await hello();
      if (
        action !== "computer.cancel" &&
        action !== "computer.verify" &&
        (session.terminal || session.stopping)
      )
        throw new ComputerUseError(
          "session_stopped",
          "The computer-use session has stopped and cannot accept more input.",
          { effectStatus: "not_dispatched", terminalCause: session.terminal ?? "stop_pending" },
        );
      if (action === "computer.renew") {
        if (!session.leased)
          throw new ComputerUseError(
            "window_lease_not_enabled",
            "This session does not have a renewable window lease.",
          );
        const value = await native.call("renew", { sessionId });
        if (session.terminal || session.stopping || admittedGeneration !== generation)
          throw new ComputerUseError("session_stopped", "This computer-use session has stopped.");
        if (!isRecord(value) || value.sessionId !== sessionId || value.status !== "renewed")
          throw new ComputerUseError(
            "invalid_lease_receipt",
            "The helper returned an invalid renewal.",
          );
        const lease = parseComputerUseWindowLease(value.lease);
        session.leaseDeadline = Math.max(
          session.leaseDeadline ?? 0,
          monotonic() + lease.remainingMs,
        );
        result = { sessionId, status: "renewed", lease };
      } else if (action === "computer.observe") {
        const region = args.region as ComputerUseObservationRegion | undefined;
        if (region !== undefined && !session.observationRegion)
          throw new ComputerUseError(
            "observation_region_unsupported",
            "The bound helper does not support observations of a window region.",
          );
        if (session.busy)
          throw new ComputerUseError(
            "busy",
            "Wait for the in-flight input before observing its result.",
          );
        if (args.screenshot === true && !binary)
          throw new ComputerUseError(
            "binary_transport_required",
            "Window screenshots require the binary computer-use transport. With rome-node device run, pass --output <window.png>.",
          );
        const epoch = ++session.observationEpoch;
        session.observation = undefined;
        session.expiresAt = undefined;
        const changedRegion = !sameComputerUseObservationRegion(region, session.state?.region);
        const full = args.full === true || changedRegion;
        const value = await native.call("observe", {
          sessionId,
          screenshot: args.screenshot === true,
          full,
          ...(!changedRegion && (args.baseVersion !== undefined || session.state !== undefined)
            ? { baseVersion: args.baseVersion ?? session.state?.stateVersion }
            : {}),
          ...(region !== undefined ? { region } : {}),
        });
        if (session.terminal || session.stopping || admittedGeneration !== generation)
          throw new ComputerUseError(
            "session_stopped",
            "A late observation cannot reopen a stopped session.",
          );
        if (epoch !== session.observationEpoch)
          throw new ComputerUseError(
            "superseded_observation",
            "A newer observation superseded this result.",
          );
        const observation = parseComputerUseObservation(value, sessionId);
        if (
          !sameComputerUseObservationRegion(region, observation.region) ||
          (region !== undefined && full && observation.delta?.mode !== "full")
        )
          throw new ComputerUseError(
            "invalid_helper_response",
            "The helper returned an observation with the wrong region or snapshot mode.",
          );
        if (observation.screenshot !== undefined) {
          const screenshot: unknown = observation.screenshot;
          if (
            !binary ||
            !isRecord(screenshot) ||
            screenshot.mimeType !== "image/png" ||
            typeof screenshot.data !== "string" ||
            screenshot.data.length > 7 * 1024 * 1024 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(screenshot.data) ||
            !Number.isSafeInteger(screenshot.width) ||
            !Number.isSafeInteger(screenshot.height) ||
            (screenshot.width as number) <= 0 ||
            (screenshot.height as number) <= 0
          )
            throw new ComputerUseError(
              "invalid_helper_response",
              "The helper returned an invalid window image.",
            );
          const image = Buffer.from(screenshot.data, "base64");
          if (
            image.length < 33 ||
            !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            image.readUInt32BE(8) !== 13 ||
            !image.subarray(12, 16).equals(Buffer.from([73, 72, 68, 82])) ||
            image.readUInt32BE(16) !== screenshot.width ||
            image.readUInt32BE(20) !== screenshot.height ||
            (screenshot.width as number) * (screenshot.height as number) > 16_777_216
          )
            throw new ComputerUseError(
              "invalid_helper_response",
              "The PNG dimensions do not match the bounded window observation.",
            );
          const { data: _data, ...metadata } = screenshot;
          observation.screenshot = {
            ...metadata,
            mimeType: "image/png",
            byteLength: image.length,
            sha256: createHash("sha256").update(image).digest("hex"),
            width: screenshot.width as number,
            height: screenshot.height as number,
          };
          body = image;
        } else if (args.screenshot === true)
          throw new ComputerUseError(
            "invalid_helper_response",
            "The helper omitted the requested window image.",
          );
        session.state = mergeComputerUseObservation(session.state, observation);
        session.observation = session.state;
        session.expiresAt =
          monotonic() +
          Math.max(0, Math.min(15, observation.validity.expiresAt - now() / 1000)) * 1000;
        result = observation;
      } else if (action === "computer.act") {
        const input = args.action as Record<string, unknown>;
        if (
          !session.allowedActions.has(String(input.type)) ||
          (session.windowSemantics &&
            (args.ref === undefined ||
              (input.type === "click" &&
                (input.x !== undefined ||
                  input.y !== undefined ||
                  (input.button !== undefined && input.button !== "left") ||
                  (input.clickCount !== undefined && input.clickCount !== 1))))) ||
          (input.type === "setValue" && String(input.value).length > session.maxValueLength) ||
          (input.type === "type" && String(input.text).length > session.maxTextLength)
        )
          throw new ComputerUseError(
            "unsupported_action",
            "This action exceeds the bound window's advertised capabilities or text limit.",
          );
        if (laneUnknown)
          throw new ComputerUseError(
            "computer_lane_unknown",
            "An earlier action may still be running. Read computer.status before a new session acts; never replay the earlier action.",
          );
        if (session.busy)
          throw new ComputerUseError(
            "busy",
            "A computer-use action is already in flight for this session.",
          );
        if (session.actions.has(String(args.actionId)))
          throw new ComputerUseError(
            "duplicate_action",
            "This session already issued that action id. It cannot be replayed.",
          );
        const observation = session.observation;
        const element =
          args.ref === undefined
            ? undefined
            : observation?.elements.find((candidate) => candidate.ref === args.ref);
        if (
          !observation ||
          (!observation.complete && !session.partialObservations) ||
          observation.observationId !== args.observationId ||
          observation.stateVersion !== args.stateVersion ||
          (args.ref !== undefined && !element) ||
          session.expiresAt === undefined ||
          monotonic() >= session.expiresAt
        )
          throw new ComputerUseError(
            "stale_observation",
            "Observe again and make a new decision with a new action id. The previous observation cannot authorize input.",
            { effectStatus: "not_dispatched" },
          );
        const elementActions = element?.actions;
        if (
          session.windowSemantics &&
          (!Array.isArray(elementActions) || !elementActions.includes(input.type))
        )
          throw new ComputerUseError(
            "unsupported_action",
            "The selected element does not advertise this action.",
            { effectStatus: "not_dispatched" },
          );
        const inputEpoch = helperEpoch;
        session.busy = true;
        const actionId = String(args.actionId);
        let key: string | undefined;
        try {
          key = await ledger.intent(peer, sessionId, actionId, {
            operation: input.type,
            ...(typeof input.value === "string"
              ? {
                  valueBytes: Buffer.byteLength(input.value),
                  valueSha256: createHash("sha256").update(input.value).digest("hex"),
                }
              : {}),
            ...(typeof input.text === "string"
              ? {
                  textBytes: Buffer.byteLength(input.text),
                  textSha256: createHash("sha256").update(input.text).digest("hex"),
                }
              : {}),
          });
          if (session.stopping || session.terminal || admittedGeneration !== generation) {
            await ledger.outcome(key, {
              status: "not_dispatched",
              terminalCause: session.terminal ?? "connection_lost",
            });
            throw new ComputerUseError(
              "session_stopped",
              "The session stopped before input was dispatched.",
              { effectStatus: "not_dispatched" },
            );
          }
          session.observation = undefined;
          const value = await native.call("act", args);
          if (
            !isRecord(value) ||
            value.sessionId !== sessionId ||
            value.actionId !== actionId ||
            value.effectVerified !== false ||
            (value.status !== "dispatched_unverified" && !nativeTerminal(value))
          )
            throw new ComputerUseError(
              "invalid_helper_response",
              "The helper returned an invalid action receipt.",
            );
          const outcome = { ...value, sessionId, actionId, effectVerified: false };
          const checks = Array.isArray(value.dispatchChecks)
            ? value.dispatchChecks.filter(isRecord)
            : [];
          await ledger.outcome(key, {
            status: value.status,
            effectVerified: false,
            eventsPosted: dispatchCount(value.eventsPosted),
            operationsDispatched: dispatchCount(value.operationsDispatched),
            method: value.method === "ax_set_value" ? value.method : undefined,
            ...(checks.some((check) => check.foregroundActivated === true)
              ? { foregroundActivated: true }
              : {}),
            ...(checks.some((check) => check.foregroundRetry === true)
              ? { foregroundRetry: true }
              : {}),
            terminalCause: nativeTerminal(value),
          });
          session.actions.set(actionId, { key, outcome });
          await adoptTerminal(sessionId, session, value);
          result =
            session.terminal || session.stopping
              ? {
                  ...outcome,
                  terminalCause: session.terminal ?? "stop_pending",
                  status: session.terminal ?? "stopping",
                }
              : outcome;
        } catch (error) {
          if (key) {
            const noInput =
              error instanceof ComputerUseError && error.details.effectStatus === "not_dispatched";
            // An exited helper's lost reply cannot occupy its replacement's input lane.
            if (!noInput && inputEpoch === helperEpoch) laneUnknown = true;
            const terminalCause =
              error instanceof ComputerUseError ? nativeTerminal(error.details) : undefined;
            const eventsPosted =
              error instanceof ComputerUseError &&
              Number.isSafeInteger(error.details.eventsPosted) &&
              (error.details.eventsPosted as number) >= 0
                ? error.details.eventsPosted
                : undefined;
            const outcome = {
              sessionId,
              actionId,
              status: noInput ? "not_dispatched" : "unknown",
              effectVerified: false,
              ...(terminalCause ? { terminalCause } : {}),
              ...(eventsPosted !== undefined ? { eventsPosted } : {}),
              ...(error instanceof ComputerUseError ? { code: error.code } : {}),
            };
            await ledger
              .outcome(key, {
                status: outcome.status,
                effectVerified: false,
                terminalCause,
                eventsPosted,
                code: outcome.code,
              })
              .catch(() => {});
            session.actions.set(actionId, { key, outcome });
            if (terminalCause || !noInput)
              await stop(sessionId, session, terminalCause ?? "unknown").catch(() => {});
            if (!noInput) {
              await native.call("cancel", { sessionId, reason: "host_stopped" }).catch(() => {});
              throw new ComputerUseError(
                "unknown_outcome",
                "Computer input may have been partially dispatched. Do not repeat this action. Read computer.verify for its recorded outcome.",
                {
                  ...(error instanceof ComputerUseError ? error.details : {}),
                  ...(error instanceof ComputerUseError ? { originalCode: error.code } : {}),
                  effectStatus: "unknown",
                  terminalCause: terminalCause ?? session.terminal ?? "unknown",
                },
              );
            }
          }
          throw error;
        } finally {
          session.busy = false;
        }
      } else if (action === "computer.verify") {
        const actionId = String(args.actionId);
        const issued = session.actions.get(actionId);
        if (!issued)
          throw new ComputerUseError("unknown_action", "This session has not issued that action.");
        if (session.terminal === "completed")
          result = { ...(issued.verification ?? issued.outcome), terminalCause: session.terminal };
        else if (session.terminal)
          result = {
            ...issued.outcome,
            status: session.terminal,
            terminalCause: session.terminal,
            effectVerified: false,
          };
        else {
          const verificationEpoch = helperEpoch;
          const value = await native.call("verify", args).catch(async (error: unknown) => {
            if (
              !(error instanceof ComputerUseError) ||
              error.code !== "window_geometry_changed" ||
              nativeTerminal(error.details) ||
              issued.outcome.status !== "dispatched_unverified"
            )
              throw error;
            await wait(25);
            if (
              session.terminal ||
              session.stopping ||
              session.busy ||
              admittedGeneration !== generation ||
              verificationEpoch !== helperEpoch ||
              monotonic() >= session.deadline
            )
              throw error;
            return native.call("verify", args);
          });
          if (
            !isRecord(value) ||
            value.sessionId !== sessionId ||
            value.actionId !== actionId ||
            !["verified", "not_verified", "unverifiable"].includes(String(value.status)) ||
            typeof value.effectVerified !== "boolean" ||
            (value.status === "verified") !== value.effectVerified
          )
            throw new ComputerUseError(
              "invalid_helper_response",
              "The helper returned an invalid verification receipt.",
            );
          await adoptTerminal(sessionId, session, value);
          const verification = { ...value, sessionId, actionId: args.actionId };
          if (!session.terminal && !session.stopping) {
            await ledger.verification(issued.key, {
              status: String(value.status),
              effectVerified: value.effectVerified,
            });
            if (!session.terminal && !session.stopping) issued.verification = verification;
          }
          result =
            session.terminal || session.stopping
              ? {
                  ...verification,
                  status: session.terminal ?? "stopping",
                  terminalCause: session.terminal ?? "stop_pending",
                  effectVerified: false,
                }
              : verification;
        }
      } else {
        if (session.terminal)
          return {
            response: {
              type: "response",
              ok: true,
              result: {
                sessionId,
                status: session.terminal,
                terminalCause: session.terminal,
                effectVerified: false,
              },
            },
            body,
          };
        session.stopping = true;
        session.observation = undefined;
        session.state = undefined;
        session.expiresAt = undefined;
        const value = await native
          .call("cancel", { sessionId, reason: "cancelled" })
          .catch(async (error: unknown) => {
            await stop(sessionId, session, "unknown");
            throw error;
          });
        if (!isRecord(value))
          throw new ComputerUseError(
            "invalid_helper_response",
            "The helper returned an invalid cancellation receipt.",
          );
        await stop(sessionId, session, nativeTerminal(value) ?? "cancelled");
        await recordConfirmedStop(sessionId, value);
        result = {
          ...value,
          sessionId,
          terminalCause: session.terminal,
          status: session.terminal,
          effectVerified: false,
        };
      }
    }
    return { response: { type: "response", ok: true, result }, body };
  }
  return {
    describe,
    status: describe,
    async requestPermissions() {
      try {
        if (!supported)
          throw new ComputerUseError(
            "unsupported_platform",
            "Native computer use requires an Apple Silicon Mac.",
          );
        return { type: "response", ok: true, result: await native.call("requestPermissions", {}) };
      } catch (error) {
        return failed(error);
      }
    },
    async idle() {
      await Promise.all([...stopping]);
    },
    async run(action, args, peer, authority) {
      try {
        return (await perform(action, args, peer, false, authority)).response;
      } catch (error) {
        return failed(await confirmErrorStop(args, peer, error), action);
      }
    },
    async runBinary(action, args, body, peer, authority) {
      try {
        if (body.byteLength)
          throw new ComputerUseError(
            "invalid_args",
            "Computer-use requests do not accept an input body.",
          );
        return await perform(action, args, peer, true, authority);
      } catch (error) {
        return { response: failed(await confirmErrorStop(args, peer, error), action), body: empty };
      }
    },
    disconnect() {
      generation++;
      for (const [sessionId, session] of sessions) {
        if (session.terminal) continue;
        session.stopping = true;
        session.observation = undefined;
        session.state = undefined;
        session.expiresAt = undefined;
        const work = native
          .call("cancel", { sessionId, reason: "connection_lost" })
          .then(async (value) => {
            await stop(
              sessionId,
              session,
              isRecord(value) ? (nativeTerminal(value) ?? "connection_lost") : "unknown",
            );
            await recordConfirmedStop(sessionId, value);
          })
          .catch(async () => {
            await stop(sessionId, session, "unknown").catch(() => {});
          })
          .finally(() => {
            stopping.delete(work);
          });
        stopping.add(work);
      }
    },
  };
}
