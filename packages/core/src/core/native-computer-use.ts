import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createNodeClient, nodeConfigFromEnvironment } from "@rome-os/node-core/client";
import {
  computerUseAction,
  parseComputerUseObservation,
  parseComputerUseReceipt,
  parseComputerUseWindowLease,
  sameComputerUseObservationRegion,
  type ComputerUseHost,
  type ComputerUseObservation,
  type ComputerUseObservationRegion,
} from "@rome-os/node-core/computer-use";
import { FRAME_VERSION, type ActionResponse } from "@rome-os/node-core";
import { askingDeviceOf } from "../connections/device/live-route.js";
import {
  permitsComputerUse,
  type AgentComputerUse,
  type RomeToolResult,
  type TurnFacts,
} from "../agent/index.js";
import { discoverComputerUseDevice } from "./computer-use-discovery.js";
import {
  compactElementDefaults,
  type ComputerObservationState,
  type ComputerObservationView,
  presentComputerObservation,
} from "./computer-use-observation-view.js";

const id = z.string().min(1).max(200);
const actionId = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => !value.includes("\0"));
const preemptToken = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("\0"));
const sessionInput = z.object({ sessionId: id }).strict();
const coordinate = z.number().finite().min(0).max(16384);
const observationRegion = z
  .object({
    x: coordinate.int(),
    y: coordinate.int(),
    width: coordinate.int().positive(),
    height: coordinate.int().positive(),
    fromEnd: z.boolean().optional(),
  })
  .strict()
  .refine((region) => region.x + region.width <= 16384 && region.y + region.height <= 16384);
const plainString = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => !value.includes("\0"));
const computerInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setValue"), value: plainString(16384) }).strict(),
  z.object({ type: z.literal("press") }).strict(),
  z.object({ type: z.literal("move"), x: coordinate, y: coordinate }).strict(),
  z
    .object({
      type: z.literal("click"),
      x: coordinate.optional(),
      y: coordinate.optional(),
      button: z.enum(["left", "right"]).optional(),
      clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      x: coordinate,
      y: coordinate,
      toX: coordinate,
      toY: coordinate,
      durationMs: z.number().int().min(100).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: coordinate.optional(),
      y: coordinate.optional(),
      deltaY: z.number().int().min(-2000).max(2000),
      deltaX: z.number().int().min(-2000).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      key: plainString(32).min(1),
      modifiers: z
        .array(z.enum(["command", "control", "alt", "shift"]))
        .max(4)
        .refine((v) => new Set(v).size === v.length)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("type"), text: plainString(4096).min(1) }).strict(),
  z
    .object({
      type: z.literal("selectText"),
      text: plainString(4096).min(1),
      prefix: plainString(4096).optional(),
      suffix: plainString(4096).optional(),
      selectionType: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("performAction"), action: plainString(128).min(1) }).strict(),
]);
const expectation = z
  .object({
    role: plainString(4096).optional(),
    identifier: plainString(4096).optional(),
    title: plainString(4096).optional(),
    value: plainString(4096).optional(),
    contains: plainString(4096).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined));
const actionInput = sessionInput
  .extend({
    actionId,
    observationId: id,
    stateVersion: z.number().int().nonnegative(),
    ref: id.optional(),
    action: computerInput,
    expect: expectation.optional(),
    navigation: z.boolean().optional(),
    verifyAfter: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const action = value.action;
    if (
      value.navigation &&
      (action.type !== "click" ||
        !value.ref ||
        action.button === "right" ||
        action.clickCount === 2)
    )
      context.addIssue({
        code: "custom",
        message: "Navigation requires a single primary click on a referenced control.",
      });
    if (["setValue", "press", "selectText", "performAction"].includes(action.type) && !value.ref)
      context.addIssue({
        code: "custom",
        message: "This semantic action requires an element reference.",
      });
    if (action.type === "click" || action.type === "scroll") {
      if (
        (action.x === undefined) !== (action.y === undefined) ||
        (action.x === undefined && !value.ref)
      )
        context.addIssue({
          code: "custom",
          message: "Use an element reference or a complete coordinate pair.",
        });
    }
  });
const application = plainString(200).trim().min(1).optional();
const bindInput = z
  .object({
    deviceId: id,
    windowRef: id,
    application,
    backgroundOnly: z.boolean().optional(),
    lease: z.boolean().optional(),
    requireSessionEnd: z.boolean().optional(),
  })
  .strict();
const recoveryReceipt = z.object({
  actionId,
  status: z.enum(["not_dispatched", "dispatched_unverified", "unknown"]),
  effectVerified: z.boolean(),
  verificationStatus: z
    .enum(["verified", "not_verified", "unverifiable"])
    .optional()
    .catch(undefined),
  stopConfirmed: z.boolean(),
  terminalCause: z
    .string()
    .regex(/^[a-z0-9_]{1,100}$/)
    .optional()
    .catch(undefined),
});
const previousStopReceipt = z.object({ stopConfirmed: z.literal(true), terminalCause: actionId });
const schemas = {
  status: z.object({ deviceId: id.optional() }).strict(),
  discover: z.object({ deviceId: id }).strict(),
  windows: z.object({ deviceId: id, application }).strict(),
  bind: bindInput,
  preempt: bindInput.extend({ preemptToken }),
  observe: sessionInput
    .extend({
      screenshot: z.boolean().optional(),
      full: z.boolean().optional(),
      baseVersion: z.number().int().nonnegative().optional(),
      region: observationRegion.optional(),
      view: z.enum(["compact", "detailed"]).default("compact"),
      subtreeRef: id.optional(),
    })
    .strict(),
  act: actionInput,
  verify: sessionInput.extend({ actionId }).strict(),
  cancel: sessionInput,
  end: sessionInput,
  renew: sessionInput,
  recover: z.object({ deviceId: id, actionId }).strict(),
};
const screenshotSchema = z.object({
  mimeType: z.literal("image/png"),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const MAX_SESSIONS = 128;
type Client = Pick<
  ReturnType<typeof createNodeClient>,
  "listDevices" | "run" | "runBinary" | "disconnect"
>;
interface Binding {
  owner: string;
  actorUserId?: string;
  actorAccountId?: string;
  agentSessionId: string;
  turnId: string | undefined;
  deviceId: string;
  nativeSessionId: string;
  scope: "desktop" | "background";
  windowDirected: boolean;
  supportsObservationRegion: boolean;
  foregroundNavigationFallback: boolean;
  supportsEnd: boolean;
  leased: boolean;
  actions: Set<string>;
  maxValueLength: number;
  observationRequest?: number;
  lastObservation?: ComputerObservationState;
  expiresAt: number;
  terminal?: string;
  stopConfirmed?: true;
  cancelling?: Promise<ActionResponse>;
}
interface WindowReference {
  owner: string;
  actorUserId?: string;
  actorAccountId?: string;
  agentSessionId: string;
  turnId: string | undefined;
  deviceId: string;
  nativeRef: string;
  applicationNames: string[];
  foregroundNavigationFallback: boolean;
  expiresAt: number;
  binding?: boolean;
  preemption?: { token: string; nativeToken: string; turnId: string; grantExpiresAt: number };
}
interface PendingBinding {
  reference: WindowReference;
  settled: Promise<void>;
  cancelled?: true;
}

interface Options {
  createClient?: () => Client;
  placeAudience?: (turn: TurnFacts) => Promise<"private" | "shared" | undefined>;
  monotonicNow?: () => number;
  local?: { deviceId: string; name: string; host: ComputerUseHost };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeApplication(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

function text(value: unknown, isError = false): RomeToolResult {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 256 * 1024) {
    return {
      content: [{ type: "text", text: "Computer-use response exceeded the observation budget." }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: serialized }],
    ...(isError ? { isError: true } : {}),
  };
}

function error(code: string, message: string): RomeToolResult {
  return text({ ok: false, error: { code, message } }, true);
}

function owner(turn: TurnFacts): string {
  const actor = turn.actor();
  return JSON.stringify([
    turn.sessionId,
    turn.agentName,
    actor?.kind,
    actor?.userId,
    actor?.accountId,
  ]);
}

function replaceSession(value: unknown, sessionId: string, modelActionId?: string): unknown {
  const record = object(value);
  if (!record) return value;
  const result: Record<string, unknown> = {
    ...record,
    sessionId,
    ...(modelActionId === undefined ? {} : { actionId: modelActionId }),
  };
  if (Array.isArray(record.dispatchChecks)) {
    // Routing diagnostics stay on the host. The model verifies the resulting page.
    result.dispatchChecks = record.dispatchChecks.map((check: unknown) => {
      const fields = object(check);
      if (!fields) return check;
      const { foregroundActivated: _activated, foregroundRetry: _retry, ...proof } = fields;
      return proof;
    });
  }
  return result;
}

function hideActionErrorIds(response: Extract<ActionResponse, { ok: false }>) {
  const details = object(response.error.details);
  if (!details || (!("sessionId" in details) && !("actionId" in details))) return response;
  const { sessionId: _sessionId, actionId: _actionId, ...publicDetails } = details;
  return { ...response, error: { ...response.error, details: publicDetails } };
}

function windowRecovery(response: Extract<ActionResponse, { ok: false }>) {
  const { code, details } = response.error;
  const cause = details?.terminalCause;
  let message: string;
  if (code === "target_must_be_background" || code === "target_takeover" || cause === "takeover") {
    message =
      "The target acquired system focus. The device could not determine who or what changed focus. When the window is back in the background, list windows on the same authorized device, bind the target again and observe before deciding the next action. Never replay input with an unknown effect.";
  } else if (code === "focus_transitioning") {
    message =
      "Window focus is changing. Wait for it to settle. Refresh the observation on an active binding, or list and bind the same background window if no binding is active. Decide any new action from the fresh state.";
  } else if (
    cause === "invalidated" ||
    cause === "screen_capture_stopped" ||
    [
      "window_missing",
      "window_not_onscreen",
      "window_missing_or_not_visible",
      "window_bounds_unavailable",
      "window_application_hidden_or_unavailable",
      "window_minimized_or_unavailable",
    ].includes(code)
  ) {
    message =
      "The device could not prove the target window's identity or availability. A covered window can still be eligible. List windows for the intended application on the same authorized device. If the window is eligible, bind it again and observe before deciding the next action. Never replay input with an unknown effect.";
  } else {
    return response;
  }
  return { ...response, error: { ...response.error, message } };
}

function boundObservation(
  binding: Binding,
  value: unknown,
  full: boolean,
  binary: boolean,
  region: ComputerUseObservationRegion | undefined,
) {
  try {
    const observation = parseComputerUseObservation(value, binding.nativeSessionId);
    const { delta } = observation;
    const prior = binding.lastObservation?.source;
    if (
      (observation.scope !== undefined && observation.scope !== "background") ||
      !sameComputerUseObservationRegion(observation.region, region) ||
      (!binary && observation.screenshot !== undefined) ||
      (prior &&
        !sameComputerUseObservationRegion(prior.region, region) &&
        (delta?.mode !== "full" ||
          prior.delta?.lineageId === delta.lineageId ||
          observation.stateVersion <= prior.stateVersion)) ||
      (delta?.mode === "delta" &&
        (full ||
          !prior?.complete ||
          !sameComputerUseObservationRegion(prior.region, region) ||
          prior.stateVersion !== delta.baseVersion ||
          prior.delta?.lineageId !== delta.lineageId)) ||
      (delta?.mode === "full" &&
        prior?.delta?.lineageId === delta.lineageId &&
        observation.stateVersion <= prior.stateVersion)
    )
      return undefined;
    return observation;
  } catch {
    return undefined;
  }
}

function publicObservation(
  observation: ComputerUseObservation,
  sessionId: string,
  view: ComputerObservationView,
  subtreeRef?: string,
) {
  const { delta } = observation;
  return {
    ...observation,
    ...(view === "compact"
      ? compactElementDefaults(observation.elements)
      : { elementDefaults: undefined }),
    sessionId,
    view,
    subtreeRef,
    ...(delta
      ? {
          delta: {
            ...delta,
            lineageId: createHash("sha256")
              .update(JSON.stringify([sessionId, view, subtreeRef ?? null, delta.lineageId]))
              .digest("base64url"),
          },
        }
      : {}),
  };
}

const invalidActionReceipt = {
  code: "invalid_action_receipt",
  message: "The computer returned a receipt that could not be matched to this action.",
};

function hasActionReceipt(value: unknown, binding: Binding, actionId: string): boolean {
  try {
    parseComputerUseReceipt(value, binding.nativeSessionId, actionId);
    return true;
  } catch {
    return false;
  }
}

function unknown(response: ActionResponse): boolean {
  return response.ok
    ? object(response.result)?.status === "unknown"
    : response.error.code === "unknown_outcome";
}

function stopBindingLocally(binding: Binding, cause: string) {
  binding.terminal ??= cause;
  binding.lastObservation = undefined;
}

function adoptTerminal(binding: Binding, response: ActionResponse): void {
  const details = response.ok ? object(response.result) : object(response.error.details);
  const cause = details?.terminalCause;
  if (typeof cause === "string" && cause.length > 0 && cause.length <= 100)
    stopBindingLocally(binding, cause);
  else if (unknown(response)) stopBindingLocally(binding, "unknown");
  else if (
    !response.ok &&
    ["caller_connection_changed", "device_connection_changed"].includes(response.error.code)
  )
    stopBindingLocally(binding, response.error.code);
  else if (
    !response.ok &&
    ["session_stopped", "session_expired", "unknown_session", "session_not_found"].includes(
      response.error.code,
    )
  )
    stopBindingLocally(binding, "invalidated");
}

/** A call never retries. Native sessions remain bound to the admitting actor, agent and device. */
export function createNativeComputerUseService(options: Options = {}): AgentComputerUse & {
  listDevices(): Promise<unknown>;
  cancelDevice(deviceId: string, actor?: { userId: string; accountId?: string }): Promise<void>;
  close(): Promise<void>;
} {
  let client: Client | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let opening = 0;
  const pendingBindings = new Set<PendingBinding>();
  const bindings = new Map<string, Binding>();
  const windows = new Map<string, WindowReference>();
  const local = options.local;
  const localPeer = local ? `local-core:${local.deviceId}` : undefined;
  const now = options.monotonicNow ?? (() => performance.now());
  const node = () =>
    (client ??=
      options.createClient?.() ?? createNodeClient(nodeConfigFromEnvironment(process.env)));
  const permits = (turn: TurnFacts) => !closed && permitsComputerUse(turn);
  const admitted = async (turn: TurnFacts) =>
    permits(turn) && (await options.placeAudience?.(turn)) !== "shared" && permits(turn);
  const scopedOwner = (turn: TurnFacts) => JSON.stringify([owner(turn), turn.turnId()]);
  // Recovery spans turns and Core restarts, while window references belong to one live turn.
  const wireActionId = (actionOwner: string, deviceId: string, modelActionId: string) =>
    "cu1-" +
    createHash("sha256")
      .update(JSON.stringify([actionOwner, deviceId, modelActionId]))
      .digest("hex");
  const denied = (
    code: string,
    message = "This device request could not be authorized.",
  ): ActionResponse => ({
    type: "response",
    ok: false,
    error: {
      code,
      message,
      details: { effectStatus: "not_dispatched" },
    },
  });
  const runWire = async (
    deviceId: string,
    action: string,
    args: Record<string, unknown>,
    stillAuthorized: () => Promise<number | false>,
  ): Promise<ActionResponse> => {
    if (!(await stillAuthorized())) return denied("computer_use_denied");
    if (local && localPeer && deviceId === local.deviceId) {
      if (action === "system.info") {
        const capability = await local.host.describe();
        const actions = Array.isArray(capability.actions)
          ? capability.actions.filter((name) => typeof name === "string" && computerUseAction(name))
          : [];
        return {
          type: "response",
          ok: true,
          result: {
            name: local.name,
            platform: process.platform === "darwin" ? "macos" : process.platform,
            actions: ["system.info", ...actions],
            capabilities: [{ ...capability, actions }],
          },
        };
      }
      if (!computerUseAction(action)) return denied("computer_use_denied");
      return local.host.run(
        action,
        args,
        localPeer,
        action === "computer.preempt" ? { allowPreemption: true } : undefined,
      );
    }
    if (action !== "system.info" && !computerUseAction(action))
      return denied("computer_use_denied");
    return node().run(deviceId, action, args);
  };
  const runBinaryWire = async (
    deviceId: string,
    action: string,
    args: Record<string, unknown>,
    stillAuthorized: () => Promise<number | false>,
  ) => {
    if (!(await stillAuthorized()))
      return { response: denied("computer_use_denied"), body: new Uint8Array() };
    if (local && localPeer && deviceId === local.deviceId && action === "computer.observe")
      return local.host.runBinary(action, args, new Uint8Array(), localPeer);
    if (!computerUseAction(action))
      return { response: denied("computer_use_denied"), body: new Uint8Array() };
    return node().runBinary(deviceId, action, args);
  };
  const listDevices = async (only?: string) => {
    if (closed) throw new Error("Computer use is closed.");
    const configured: Array<{ id: string; name: string; platform?: string }> = [];
    if (local && (only === undefined || only === local.deviceId)) {
      configured.push({
        id: local.deviceId,
        name: local.name,
        platform: process.platform === "darwin" ? "macos" : process.platform,
      });
    }
    if (only !== undefined && configured.length > 0) {
      return { devices: configured, note: "Use capability discovery to check device readiness." };
    }
    try {
      const result = await node().listDevices();
      const seen = new Set(configured.map((device) => device.id));
      for (const device of result.items) {
        if (device.revoked_at || seen.has(device.id)) continue;
        if (only !== undefined && device.id !== only) continue;
        seen.add(device.id);
        configured.push({
          id: device.id,
          name:
            typeof device.device_name === "string" && device.device_name.trim()
              ? device.device_name
              : device.id,
          ...(typeof device.platform === "string" ? { platform: device.platform } : {}),
        });
      }
      return {
        devices: configured,
        note: "Authorization records do not establish that a computer is online.",
      };
    } catch (cause) {
      if (configured.length > 0)
        return { devices: configured, note: "Use capability discovery to check device readiness." };
      throw cause;
    }
  };
  const cancelBinding = (binding: Binding) => {
    if (binding.cancelling) return binding.cancelling;
    // Latch before awaiting the network so an overlapping act cannot pass admission.
    stopBindingLocally(binding, "cancel_requested");
    binding.cancelling = runWire(
      binding.deviceId,
      "computer.cancel",
      {
        sessionId: binding.nativeSessionId,
      },
      async () => Infinity,
    )
      .then((response) => {
        const result = response.ok ? object(response.result) : undefined;
        if (
          result?.sessionId === binding.nativeSessionId &&
          actionId.safeParse(result.terminalCause).success
        ) {
          if (binding.terminal === "cancel_requested")
            binding.terminal = String(result.terminalCause);
          if (result.stopConfirmed === true) binding.stopConfirmed = true;
        }
        return response;
      })
      .finally(() => {
        binding.cancelling = undefined;
      });
    return binding.cancelling;
  };
  const cancelMatching = async (matches: (entry: Binding | WindowReference) => boolean) => {
    const pending: Promise<void>[] = [];
    for (const bind of pendingBindings) {
      if (!matches(bind.reference)) continue;
      bind.cancelled = true;
      pending.push(bind.settled);
    }
    for (const [ref, entry] of windows) if (matches(entry)) windows.delete(ref);
    const selected = [...bindings].filter(([, binding]) => matches(binding));
    for (const [, binding] of selected) stopBindingLocally(binding, "cancel_requested");
    await Promise.allSettled([
      ...pending,
      ...selected.flatMap(([, binding]) => (binding.stopConfirmed ? [] : [cancelBinding(binding)])),
    ]);
    for (const [id] of selected) bindings.delete(id);
  };
  const cancelScope = (agentSessionId: string, turnId?: string) =>
    cancelMatching(
      (entry) =>
        entry.agentSessionId === agentSessionId &&
        (turnId === undefined || entry.turnId === turnId),
    );
  const cancelDevice = (deviceId: string, actor?: { userId: string; accountId?: string }) =>
    cancelMatching(
      (entry) =>
        entry.deviceId === deviceId &&
        (!actor ||
          (entry.actorUserId === actor.userId &&
            (entry.actorAccountId ?? undefined) === (actor.accountId ?? undefined))),
    );
  return {
    permits,
    listDevices,
    async run(turn, operation, input) {
      const admittingOwner = scopedOwner(turn);
      const actionOwner = owner(turn);
      const admittingTurn = turn.turnId();
      const inputAlive = turn.captureTaskInputLiveness?.() ?? (() => turn.live?.() === true);
      const sameTurn = () =>
        inputAlive() && scopedOwner(turn) === admittingOwner && turn.turnId() === admittingTurn;
      const admittedHere = async () => sameTurn() && (await admitted(turn)) && sameTurn();
      const grant = turn.computerUseGrant?.();
      const hasDeviceGrant = (deviceId: unknown, preemption = false) => {
        const current = turn.computerUseGrant?.();
        return Boolean(
          admittingTurn &&
            grant &&
            current &&
            current.deviceId === deviceId &&
            current.deviceId === grant.deviceId &&
            current.expiresAt === grant.expiresAt &&
            Date.now() < current.expiresAt &&
            (!preemption || (grant.allowPreemption === true && current.allowPreemption === true)),
        );
      };
      const hasGrant = () => hasDeviceGrant(grant?.deviceId);
      if (!(await admittedHere()))
        return error(
          "computer_use_denied",
          "Computer use requires an authorized live guardian turn in a private chat.",
        );
      const parsed = schemas[operation].safeParse(input);
      if (!parsed.success)
        return error("invalid_args", "Arguments do not match the computer-use operation schema.");
      const args = parsed.data as Record<string, unknown>;
      const requestedApplication =
        typeof args.application === "string" ? args.application : undefined;
      const needsDeviceGrant = operation === "preempt" || operation === "recover";
      const hasOperationGrant = () =>
        hasGrant() && (!needsDeviceGrant || hasDeviceGrant(args.deviceId, operation === "preempt"));
      const authorizedHere = async () =>
        hasOperationGrant() &&
        (grant?.isCurrent === undefined || (await grant.isCurrent())) &&
        (await admittedHere()) &&
        hasOperationGrant()
          ? (grant?.expiresAt ?? Infinity)
          : false;
      if (
        (operation !== "status" || args.deviceId !== undefined) &&
        (!(await authorizedHere()) ||
          (args.deviceId !== undefined && args.deviceId !== grant?.deviceId))
      )
        return error(
          "computer_use_denied",
          "Authorize this device, then choose it for computer use.",
        );
      if (operation === "recover") {
        const deviceId = String(args.deviceId);
        const modelActionId = String(args.actionId);
        const nativeActionId = wireActionId(actionOwner, deviceId, modelActionId);
        const response = await runWire(
          deviceId,
          "computer.recover",
          { actionId: nativeActionId },
          authorizedHere,
        );
        if (!(await authorizedHere()))
          return error("computer_use_denied", "The admitting turn is no longer authorized.");
        if (!response.ok)
          return error(response.error.code, "The device could not read this recorded action.");
        const receipt = recoveryReceipt.safeParse(response.result);
        if (!receipt.success || receipt.data.actionId !== nativeActionId)
          return error("invalid_response", "The device returned no valid recovery receipt.");
        const { verificationStatus, ...outcome } = receipt.data;
        const verification =
          outcome.status === "dispatched_unverified" &&
          outcome.effectVerified === (verificationStatus === "verified")
            ? verificationStatus
            : undefined;
        return text({
          ...response,
          result: {
            ...outcome,
            actionId: modelActionId,
            effectVerified: verification === "verified",
            verificationStatus: verification,
          },
        });
      }
      if (operation === "discover") {
        const deviceId = String(args.deviceId);
        const localTarget = deviceId === local?.deviceId;
        const discovery = await discoverComputerUseDevice(deviceId, {
          run: async (target, action, input) =>
            runWire(target, action, object(input) ?? {}, authorizedHere),
        });
        if (!(await authorizedHere()))
          return error("computer_use_denied", "The admitting turn is no longer authorized.");
        const usable =
          discovery.availability === "online" &&
          discovery.audit !== "unavailable" &&
          discovery.computer?.enabled !== false &&
          discovery.computer?.configured !== false;
        const candidates = discovery.computer?.actions ?? [];
        const candidateSet = new Set(candidates);
        const background = discovery.computer?.background;
        const authorizedActions = usable
          ? candidates.filter((action) => {
              if (!computerUseAction(action)) return false;
              if (action === "computer.end" && background?.sessionEnd !== true) return false;
              if (action === "computer.renew" && background?.windowLease !== true) return false;
              if (
                action === "computer.preempt" &&
                (background?.windowPreemption !== true || !hasDeviceGrant(deviceId, true))
              )
                return false;
              return (
                (action !== "computer.bind" && action !== "computer.preempt") ||
                candidateSet.has("computer.cancel")
              );
            })
          : [];
        return text({
          ...discovery,
          authorizedActions,
          binaryFrames:
            authorizedActions.includes("computer.observe") &&
            (localTarget || discovery.frameVersion === FRAME_VERSION),
        });
      }
      if (operation === "status" && args.deviceId === undefined) {
        try {
          const selected = (await authorizedHere()) ? grant?.deviceId : undefined;
          const devices = await listDevices(selected);
          if (!(await admittedHere()))
            return error("computer_use_denied", "The admitting turn is no longer authorized.");
          if (selected && hasGrant())
            return text({
              devices: devices.devices.filter((device) => device.id === selected),
              approvedDeviceId: selected,
              note: devices.note,
            });
          return text({ ...devices, askingDeviceId: askingDeviceOf(turn.threadContext()) ?? null });
        } catch {
          return error("gateway_unavailable", "Rome could not list authorized computers.");
        }
      }
      if (operation === "status" || operation === "windows") {
        try {
          const started = now();
          const deviceId = String(args.deviceId);
          const response = await runWire(deviceId, `computer.${operation}`, {}, authorizedHere);
          if (!(await authorizedHere()))
            return error("computer_use_denied", "The admitting turn is no longer authorized.");
          if (operation !== "windows" || !response.ok) return text(response, !response.ok);
          const result = object(response.result);
          const listed = z
            .array(z.object({ windowRef: id }).passthrough())
            .max(512)
            .safeParse(result?.windows);
          if (!listed.success)
            return error("invalid_response", "The computer returned no valid bounded window list.");
          const expected = requestedApplication && normalizeApplication(requestedApplication);
          const eligible = listed.data
            .map((window) => ({
              window,
              applicationNames: [window.appName, window.bundleName, window.bundleId]
                .filter(
                  (name): name is string => typeof name === "string" && name.trim().length > 0,
                )
                .map(normalizeApplication),
            }))
            .filter(({ applicationNames }) => !expected || applicationNames.includes(expected));
          for (const [ref, entry] of windows) {
            if (
              entry.expiresAt <= now() ||
              (entry.owner === admittingOwner && entry.deviceId === args.deviceId)
            )
              windows.delete(ref);
          }
          if (windows.size + eligible.length > 1024)
            return error(
              "busy",
              "The window reference budget is full. Wait for old references to expire.",
            );
          const expiresAt = started + 15_000;
          const admittingActor = turn.actor();
          const refs = eligible.map(({ window, applicationNames }) => {
            const ref = randomUUID();
            windows.set(ref, {
              owner: admittingOwner,
              actorUserId: admittingActor?.userId,
              actorAccountId: admittingActor?.accountId,
              agentSessionId: turn.sessionId,
              turnId: admittingTurn,
              deviceId,
              nativeRef: window.windowRef,
              foregroundNavigationFallback:
                object(window.capabilities)?.foregroundNavigationFallback === true,
              applicationNames,
              expiresAt,
            });
            return { ...window, windowRef: ref };
          });
          return text({
            ...response,
            result: {
              ...result,
              ...(requestedApplication ? { application: requestedApplication } : {}),
              windows: refs,
            },
          });
        } catch {
          return error("gateway_unavailable", "Rome could not reach the computer.");
        }
      }
      if (operation === "bind" || operation === "preempt") {
        const windowRef = String(args.windowRef);
        const reference = windows.get(windowRef);
        if (
          !reference ||
          reference.owner !== admittingOwner ||
          reference.deviceId !== args.deviceId ||
          reference.expiresAt <= now()
        )
          return error(
            "invalid_window_ref",
            "List this device's windows in this agent session before binding one.",
          );
        if (
          requestedApplication &&
          !reference.applicationNames.includes(normalizeApplication(requestedApplication))
        )
          return error(
            "window_application_mismatch",
            "This window does not match the requested application. List windows for that application and use a matching reference.",
          );
        if (reference.binding)
          return error("busy", "A request for this window is already pending.");
        const preempting = operation === "preempt";
        const preemption = reference.preemption;
        if (
          preempting &&
          (!preemption ||
            preemption.token !== args.preemptToken ||
            preemption.turnId !== admittingTurn ||
            preemption.grantExpiresAt !== grant?.expiresAt)
        )
          return error(
            "invalid_preempt_token",
            "Use the token from this turn's busy bind for the same window.",
          );
        if (!preempting && preemption)
          return error(
            "invalid_window_ref",
            "List the window again before requesting another bind.",
          );
        if (bindings.size + opening >= MAX_SESSIONS) {
          for (const [sessionId, binding] of bindings)
            if (!binding.cancelling && (binding.stopConfirmed || binding.expiresAt <= now()))
              bindings.delete(sessionId);
        }
        if (bindings.size + opening >= MAX_SESSIONS)
          return error("busy", "Close an existing computer-use session before opening another.");
        // Reserve before awaiting the device so parallel binds share the same admission budget.
        opening++;
        let settle = () => {};
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const pending: PendingBinding = { reference, settled };
        pendingBindings.add(pending);
        const bindAuthorized = async () => {
          const deadline = await authorizedHere();
          return pending.cancelled ? false : deadline;
        };
        reference.binding = true;
        let keepReference = false;
        try {
          const response = await runWire(
            String(args.deviceId),
            `computer.${operation}`,
            {
              windowRef: reference.nativeRef,
              ...(reference.foregroundNavigationFallback && args.backgroundOnly !== true
                ? { foregroundNavigationFallback: true }
                : {}),
              ...(preempting && preemption ? { preemptToken: preemption.nativeToken } : {}),
              ...(args.lease === true ? { lease: true } : {}),
              ...(args.requireSessionEnd === true ? { requireSessionEnd: true } : {}),
            },
            bindAuthorized,
          );
          if (!response.ok) {
            if (!(await bindAuthorized()) || pending.cancelled)
              return error("computer_use_denied", "The admitting turn is no longer authorized.");
            const { code } = response.error;
            const currentReference =
              windows.get(windowRef) === reference && reference.expiresAt > now();
            if (preempting) {
              keepReference = code === "preemption_pending" && currentReference;
              return keepReference
                ? text(
                    {
                      type: "response",
                      ok: false,
                      error: {
                        code,
                        message:
                          "Cleanup is not yet confirmed. Check the same window and token again.",
                        details: { stopConfirmed: false },
                      },
                    },
                    true,
                  )
                : error(
                    code === "preemption_pending" ? "invalid_window_ref" : code,
                    "The replacement binding is unavailable. Do not replay an unknown preemption.",
                  );
            }
            if (code === "busy") {
              const nativeToken = preemptToken.safeParse(response.error.details?.preemptToken);
              if (
                nativeToken.success &&
                currentReference &&
                admittingTurn &&
                grant &&
                hasDeviceGrant(args.deviceId, true)
              ) {
                const token = randomUUID();
                reference.preemption = {
                  token,
                  nativeToken: nativeToken.data,
                  turnId: admittingTurn,
                  grantExpiresAt: grant.expiresAt,
                };
                keepReference = true;
                return text(
                  {
                    type: "response",
                    ok: false,
                    error: {
                      code,
                      message: "This exact window has an active automation.",
                      details: { preemptToken: token },
                    },
                  },
                  true,
                );
              }
              return error(code, "The device is busy.");
            }
            return text(windowRecovery(response), true);
          }
          const result = object(response.result);
          if (typeof result?.sessionId !== "string" || !id.safeParse(result.sessionId).success)
            return error("invalid_response", "The computer returned no valid session binding.");
          const capabilities = object(result.capabilities);
          if (
            (capabilities?.foregroundNavigationFallback === true &&
              (!reference.foregroundNavigationFallback || args.backgroundOnly === true)) ||
            result.scope === "desktop" ||
            capabilities?.realPointer === true
          ) {
            await runWire(
              String(args.deviceId),
              "computer.cancel",
              {
                sessionId: result.sessionId,
              },
              async () => Infinity,
            );
            return error(
              "global_input_disabled",
              "The computer did not provide an isolated background-window binding.",
            );
          }
          const supportsEnd = capabilities?.sessionEnd === true;
          const leased = args.lease === true || result.lease !== undefined;
          const previousStop = preempting
            ? previousStopReceipt.safeParse(result.preemption)
            : undefined;
          try {
            if (
              preempting &&
              (result.scope !== "background" ||
                capabilities?.realPointer !== false ||
                capabilities.windowPreemption !== true ||
                !previousStop?.success)
            )
              throw new Error("The previous stop was not confirmed.");
            if (args.requireSessionEnd === true && !supportsEnd)
              throw new Error("Normal end is unsupported.");
            if (leased) {
              if (capabilities?.windowLease !== true)
                throw new Error("Window leases are unsupported.");
              parseComputerUseWindowLease(result.lease);
            }
          } catch {
            await runWire(
              String(args.deviceId),
              "computer.cancel",
              {
                sessionId: result.sessionId,
              },
              async () => Infinity,
            );
            return error(
              "binding_capability_mismatch",
              "The binding did not confirm the requested capabilities. Discover the device again.",
            );
          }
          const windowDirected =
            capabilities?.coordinateSpace === "window_image_pixels" &&
            capabilities.realPointer === false;
          const advertised = Array.isArray(capabilities?.actions)
            ? capabilities.actions.filter((value): value is string => typeof value === "string")
            : [];
          const maxValueLength =
            windowDirected &&
            Number.isSafeInteger(capabilities?.maxValueLength) &&
            Number(capabilities?.maxValueLength) > 0
              ? Math.min(16384, Number(capabilities?.maxValueLength))
              : windowDirected
                ? 16384
                : 180;
          const sessionId = randomUUID();
          const binding: Binding = {
            owner: admittingOwner,
            actorUserId: reference.actorUserId,
            actorAccountId: reference.actorAccountId,
            agentSessionId: turn.sessionId,
            turnId: admittingTurn,
            deviceId: String(args.deviceId),
            nativeSessionId: result.sessionId,
            scope: "background",
            windowDirected,
            foregroundNavigationFallback:
              reference.foregroundNavigationFallback &&
              args.backgroundOnly !== true &&
              capabilities?.foregroundNavigationFallback === true,
            supportsObservationRegion: windowDirected && capabilities?.observationRegion === true,
            supportsEnd,
            leased,
            actions: new Set(windowDirected ? advertised : ["setValue"]),
            maxValueLength,
            expiresAt: now() + 600_000,
          };
          if (!(await bindAuthorized()) || pending.cancelled) {
            await cancelBinding(binding).catch(() => {});
            return error(
              "computer_use_denied",
              "The admitting turn ended before binding completed.",
            );
          }
          bindings.set(sessionId, binding);
          if (previousStop?.success) {
            const {
              preemptedSessionId: _previousId,
              preemptToken: _token,
              ...safeBinding
            } = result;
            return text({
              ...response,
              result: { ...safeBinding, sessionId, preemption: previousStop.data },
            });
          }
          return text({ ...response, result: replaceSession(result, sessionId) });
        } finally {
          if (windows.get(windowRef) === reference) {
            if (keepReference) reference.binding = false;
            else windows.delete(windowRef);
          }
          opening--;
          pendingBindings.delete(pending);
          settle();
        }
      }
      const sessionId = String(args.sessionId);
      const binding = bindings.get(sessionId);
      if (!binding || binding.owner !== scopedOwner(turn))
        return error("invalid_session", "This turn does not own the computer-use session.");
      if (operation === "end") {
        if (!binding.supportsEnd)
          return error(
            "session_end_unsupported",
            "This binding supports cancellation. Use computer_cancel.",
          );
        stopBindingLocally(binding, "end_requested");
        try {
          const response = await runWire(
            binding.deviceId,
            "computer.end",
            {
              sessionId: binding.nativeSessionId,
            },
            authorizedHere,
          );
          const stop = response.ok ? object(response.result) : undefined;
          const validStop =
            stop?.sessionId === binding.nativeSessionId &&
            typeof stop.stopConfirmed === "boolean" &&
            id.safeParse(stop.terminalCause).success &&
            stop.effectVerified === false;
          if (validStop && stop.stopConfirmed === true) binding.stopConfirmed = true;
          if (!(await authorizedHere()))
            return error("computer_use_denied", "The admitting turn is no longer authorized.");
          if (!response.ok) return text(response, true);
          if (!validStop)
            return error(
              "stop_unconfirmed",
              "The received stop receipt is invalid. Input remains stopped locally.",
            );
          if (binding.terminal === "end_requested") binding.terminal = String(stop.terminalCause);
          return text({ ...response, result: replaceSession(stop, sessionId) });
        } catch {
          return error(
            "stop_unconfirmed",
            "Local input is stopped. Read this session's stop again to check confirmation.",
          );
        }
      }
      if (operation === "cancel") {
        try {
          const response = await cancelBinding(binding);
          const receipt = response.ok ? object(response.result) : undefined;
          if (receipt?.sessionId !== undefined && receipt.sessionId !== binding.nativeSessionId)
            return error(
              "stop_unconfirmed",
              "The cancellation receipt belongs to another session.",
            );
          const matched = receipt?.sessionId === binding.nativeSessionId ? receipt : undefined;
          const stopConfirmed =
            matched?.stopConfirmed === true && actionId.safeParse(matched.terminalCause).success;
          return text(
            response.ok
              ? {
                  ok: true,
                  sessionId,
                  localStatus: binding.terminal,
                  result: { ...matched, sessionId, stopConfirmed },
                }
              : {
                  ok: false,
                  sessionId,
                  status: "cancel_requested",
                  localStatus: binding.terminal,
                  error: response.error,
                },
            !response.ok,
          );
        } catch {
          return error(
            "cancel_outcome_unknown",
            "Local input is stopped, but the computer has not confirmed cancellation.",
          );
        }
      }
      if (binding.terminal && operation !== "verify")
        return text(
          windowRecovery({
            type: "response",
            ok: false,
            error: {
              code: "session_stopped",
              message:
                "This computer-use session has stopped. Unknown actions must not be replayed.",
              details: { terminalCause: binding.terminal },
            },
          }),
          true,
        );
      if (operation === "renew" && !binding.leased)
        return error("window_lease_not_enabled", "This binding has no renewable lease.");
      if (operation === "act") {
        const input = args.action as z.infer<typeof computerInput>;
        if (
          !binding.actions.has(input.type) ||
          (input.type === "setValue" && input.value.length > binding.maxValueLength)
        )
          return error("invalid_args", "This action does not match the bound control scope.");
      }
      const wireArgs: Record<string, unknown> = { ...args, sessionId: binding.nativeSessionId };
      const modelActionId =
        operation === "act" || operation === "verify" ? String(args.actionId) : undefined;
      const nativeActionId =
        modelActionId === undefined
          ? undefined
          : wireActionId(actionOwner, binding.deviceId, modelActionId);
      if (nativeActionId !== undefined) wireArgs.actionId = nativeActionId;
      delete wireArgs.verifyAfter;
      if (!binding.foregroundNavigationFallback) delete wireArgs.navigation;
      try {
        if (operation === "observe") {
          const viewKind = args.view as ComputerObservationView;
          const subtreeRef = args.subtreeRef as string | undefined;
          const region = args.region as ComputerUseObservationRegion | undefined;
          delete wireArgs.view;
          delete wireArgs.subtreeRef;
          if (region && !binding.supportsObservationRegion)
            return error(
              "unsupported_observation_region",
              "This binding does not support regional observation. Request the full window observation.",
            );
          if (binding.windowDirected) {
            const prior = binding.lastObservation?.source;
            const changedRegion = !sameComputerUseObservationRegion(prior?.region, region);
            if (changedRegion) {
              wireArgs.full = true;
              delete wireArgs.baseVersion;
            } else if (!prior || args.full === true) wireArgs.full = true;
            else if (args.baseVersion === undefined) wireArgs.baseVersion = prior.stateVersion;
          }
          const request = (binding.observationRequest ?? 0) + 1;
          binding.observationRequest = request;
          const binary = wireArgs.screenshot === true;
          const reply = binary
            ? await runBinaryWire(binding.deviceId, "computer.observe", wireArgs, authorizedHere)
            : {
                response: await runWire(
                  binding.deviceId,
                  "computer.observe",
                  wireArgs,
                  authorizedHere,
                ),
                body: undefined,
              };
          if (!(await authorizedHere()) || binding.terminal) {
            await cancelBinding(binding).catch(() => {});
            return error("session_stopped", "The session stopped before observation completed.");
          }
          if (request !== binding.observationRequest)
            return error(
              "superseded_observation",
              "A newer observation request replaced this one.",
            );
          if (!reply.response.ok) {
            adoptTerminal(binding, reply.response);
            return text(windowRecovery(reply.response), true);
          }
          const observation = boundObservation(
            binding,
            reply.response.result,
            wireArgs.full === true,
            binary,
            region,
          );
          if (!observation)
            return error(
              "invalid_observation",
              "The computer returned no valid observation for this session. Request a full observation.",
            );
          adoptTerminal(binding, reply.response);
          if (binding.terminal)
            return error("session_stopped", "The session stopped before observation completed.");
          let presentation: ReturnType<typeof presentComputerObservation>;
          try {
            presentation = presentComputerObservation(
              observation,
              viewKind,
              binding.lastObservation,
              subtreeRef,
            );
          } catch {
            return error(
              "invalid_observation",
              "The computer returned an inconsistent observation. Request a full observation.",
            );
          }
          if (!presentation)
            return error(
              "observation_subtree_unavailable",
              "This observation did not contain the requested subtree. Observe the window or relevant region again and choose a current element ref.",
            );
          const view = publicObservation(presentation.observation, sessionId, viewKind, subtreeRef);
          let output: RomeToolResult;
          if (binary) {
            const screenshot = screenshotSchema.safeParse(view.screenshot);
            const body = reply.body;
            const png = body && Buffer.from(body);
            if (
              !screenshot.success ||
              !png ||
              png.length !== screenshot.data.byteLength ||
              createHash("sha256").update(png).digest("hex") !== screenshot.data.sha256 ||
              screenshot.data.width * screenshot.data.height > 16_777_216 ||
              png.length < 33 ||
              !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              png.readUInt32BE(8) !== 13 ||
              png.toString("ascii", 12, 16) !== "IHDR" ||
              png.readUInt32BE(16) !== screenshot.data.width ||
              png.readUInt32BE(20) !== screenshot.data.height
            )
              return error("invalid_image", "The computer returned an invalid bounded screenshot.");
            const metadata = text({
              ...reply.response,
              result: { ...view, screenshot: screenshot.data },
            });
            if (metadata.isError) return metadata;
            output = {
              ...metadata,
              content: [
                metadata.content[0],
                { type: "image", mimeType: screenshot.data.mimeType, data: png.toString("base64") },
              ],
            };
          } else output = text({ ...reply.response, result: view });
          if (!output.isError) binding.lastObservation = presentation.state;
          return output;
        }
        const response = await runWire(
          binding.deviceId,
          `computer.${operation}`,
          wireArgs,
          authorizedHere,
        );
        if (!(await authorizedHere())) {
          await cancelBinding(binding).catch(() => {});
          return error(
            "session_stopped",
            "The session stopped while its result was in flight. Do not replay input.",
          );
        }
        if (
          response.ok &&
          nativeActionId !== undefined &&
          !hasActionReceipt(response.result, binding, nativeActionId)
        ) {
          if (operation === "verify")
            return error(invalidActionReceipt.code, invalidActionReceipt.message);
          stopBindingLocally(binding, "unknown");
          await cancelBinding(binding).catch(() => {});
          return error(
            "unknown_outcome",
            "The action receipt did not match this request. Do not replay input.",
          );
        }
        if (
          operation === "renew" &&
          response.ok &&
          object(response.result)?.sessionId !== binding.nativeSessionId
        )
          return error("invalid_lease_receipt", "The computer returned an invalid renewal.");
        adoptTerminal(binding, response);
        const completedVerification =
          binding.terminal === "completed" &&
          operation === "verify" &&
          response.ok &&
          object(response.result)?.sessionId === binding.nativeSessionId &&
          object(response.result)?.terminalCause === "completed";
        if (binding.terminal && response.ok && !completedVerification) {
          return text({
            ok: true,
            sessionId,
            status: binding.terminal,
            effectVerified: false,
            replayAllowed: false,
            diagnosticEvidence: replaceSession(response.result, sessionId, modelActionId),
          });
        }
        if (operation === "renew" && response.ok) {
          const renewal = object(response.result);
          if (renewal?.status !== "renewed")
            return error("invalid_lease_receipt", "The computer returned an invalid renewal.");
          try {
            const lease = parseComputerUseWindowLease(renewal.lease);
            return text({ ...response, result: { sessionId, status: "renewed", lease } });
          } catch {
            return error("invalid_lease_receipt", "The computer returned an invalid window lease.");
          }
        }
        if (
          operation === "act" &&
          nativeActionId !== undefined &&
          args.verifyAfter === true &&
          response.ok &&
          object(response.result)?.status === "dispatched_unverified" &&
          object(response.result)?.effectVerified === false &&
          !binding.terminal &&
          (await authorizedHere())
        ) {
          let verification = await runWire(
            binding.deviceId,
            "computer.verify",
            {
              sessionId: binding.nativeSessionId,
              actionId: nativeActionId,
            },
            authorizedHere,
          );
          if (verification.ok && !hasActionReceipt(verification.result, binding, nativeActionId))
            verification = { type: "response", ok: false, error: invalidActionReceipt };
          adoptTerminal(binding, verification);
          if (!(await authorizedHere())) {
            await cancelBinding(binding).catch(() => {});
            return error(
              "session_stopped",
              "The session stopped while verification was in flight. Do not replay input.",
            );
          }
          if (binding.terminal)
            return text({
              sessionId,
              status: binding.terminal,
              effectVerified: false,
              replayAllowed: false,
              diagnosticEvidence: verification.ok
                ? replaceSession(verification.result, sessionId, modelActionId)
                : verification,
            });
          return text(
            {
              sessionId,
              act: replaceSession(response.result, sessionId, modelActionId),
              verify: verification.ok
                ? replaceSession(verification.result, sessionId, modelActionId)
                : hideActionErrorIds(verification),
            },
            !verification.ok,
          );
        }
        return text(
          response.ok
            ? {
                ...response,
                result: replaceSession(response.result, sessionId, modelActionId),
                ...(binding.terminal ? { status: binding.terminal } : {}),
              }
            : windowRecovery(
                nativeActionId !== undefined ? hideActionErrorIds(response) : response,
              ),
          !response.ok,
        );
      } catch {
        if (operation === "act") stopBindingLocally(binding, "unknown");
        return error(
          "unknown_outcome",
          "No trustworthy computer-use response arrived. Do not replay input.",
        );
      }
    },
    cancelTurn(agentSessionId, turnId) {
      return cancelScope(agentSessionId, turnId);
    },
    cancelSession(agentSessionId) {
      return cancelScope(agentSessionId);
    },
    cancelDevice(deviceId, actor) {
      return cancelDevice(deviceId, actor);
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        // Late binds cancel their denied sessions before the transport disconnects.
        await Promise.allSettled([
          ...[...bindings.values()].flatMap((binding) =>
            binding.stopConfirmed ? [] : [cancelBinding(binding)],
          ),
          ...[...pendingBindings].map((binding) => binding.settled),
        ]);
        bindings.clear();
        windows.clear();
        client?.disconnect();
        local?.host.disconnect();
        await local?.host.idle();
      })());
    },
  };
}
