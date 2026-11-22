import { isRecord } from "../actions.js";

export const COMPUTER_USE_PROTOCOL_VERSION = 1;
export const COMPUTER_USE_ACTIONS = [
  "computer.status",
  "computer.windows",
  "computer.bind",
  "computer.observe",
  "computer.act",
  "computer.verify",
  "computer.cancel",
  "computer.end",
  "computer.renew",
  "computer.preempt",
  "computer.recover",
] as const;
export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number];

export interface ComputerUsePermissions {
  accessibility: boolean;
  screenCapture: boolean;
  inputMonitoring?: boolean;
  postEvents?: boolean;
}
export interface ComputerUseHello {
  protocolVersion: 1;
  pid?: number;
  instanceId?: string;
  permissions: ComputerUsePermissions;
  capabilities: Record<string, unknown> & { actions: string[] };
  [key: string]: unknown;
}
export interface ComputerUseWindow {
  windowRef: string;
  title?: string;
  appName?: string;
  bundleId?: string;
  [key: string]: unknown;
}
export interface ComputerUseBinding {
  sessionId: string;
  lease?: ComputerUseWindowLease;
  [key: string]: unknown;
}
export interface ComputerUseWindowLease {
  idleTimeoutMs: number;
  renewAfterMs: number;
  remainingMs: number;
}
export interface ComputerUseRenewal {
  sessionId: string;
  status: "renewed";
  lease: ComputerUseWindowLease;
}

export function parseComputerUseWindowLease(value: unknown): ComputerUseWindowLease {
  if (
    !isRecord(value) ||
    typeof value.idleTimeoutMs !== "number" ||
    !Number.isSafeInteger(value.idleTimeoutMs) ||
    value.idleTimeoutMs <= 0 ||
    typeof value.renewAfterMs !== "number" ||
    !Number.isSafeInteger(value.renewAfterMs) ||
    value.renewAfterMs <= 0 ||
    value.renewAfterMs >= value.idleTimeoutMs ||
    typeof value.remainingMs !== "number" ||
    !Number.isSafeInteger(value.remainingMs) ||
    value.remainingMs < 0 ||
    value.remainingMs > value.idleTimeoutMs
  )
    throw new ComputerUseError(
      "invalid_lease_receipt",
      "The computer returned an invalid window lease.",
    );
  return {
    idleTimeoutMs: value.idleTimeoutMs,
    renewAfterMs: value.renewAfterMs,
    remainingMs: value.remainingMs,
  };
}
export interface ComputerUseScreenshot {
  mimeType: "image/png";
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  [key: string]: unknown;
}
export interface ComputerUseObservationRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  fromEnd?: boolean;
}
export interface ComputerUseObservation {
  sessionId: string;
  observationId: string;
  stateVersion: number;
  validity: { observedAt: number; expiresAt: number; maxAgeSeconds: 15; clock: string };
  elements: Array<Record<string, unknown> & { ref: string }>;
  complete: boolean;
  screenshot?: ComputerUseScreenshot;
  delta?: ComputerUseObservationDelta;
  region?: ComputerUseObservationRegion;
  [key: string]: unknown;
}
export interface ComputerUseObservationDelta {
  mode: "full" | "delta";
  lineageId: string;
  baseVersion: number | null;
  version: number;
  complete: boolean;
  added: string[];
  changed: string[];
  removed: string[];
}
export type ComputerUseInput =
  | { type: "setValue"; value: string }
  | { type: "press" }
  | { type: "move"; x: number; y: number }
  | { type: "click"; x?: number; y?: number; button?: "left" | "right"; clickCount?: 1 | 2 }
  | { type: "drag"; x: number; y: number; toX: number; toY: number; durationMs?: number }
  | { type: "scroll"; x?: number; y?: number; deltaY: number; deltaX?: number }
  | { type: "key"; key: string; modifiers?: Array<"command" | "control" | "alt" | "shift"> }
  | { type: "type"; text: string }
  | {
      type: "selectText";
      text: string;
      prefix?: string;
      suffix?: string;
      selectionType?: "text" | "cursor_before" | "cursor_after";
    }
  | { type: "performAction"; action: string };
export interface ComputerUseExpectation {
  role?: string;
  identifier?: string;
  title?: string;
  value?: string;
  contains?: string;
}
export interface ComputerUseAct {
  sessionId: string;
  actionId: string;
  observationId: string;
  stateVersion: number;
  ref?: string;
  action: ComputerUseInput;
  expect?: ComputerUseExpectation;
  navigation?: boolean;
}
export interface ComputerUseReceipt {
  sessionId: string;
  actionId?: string;
  status: string;
  effectVerified: boolean;
  [key: string]: unknown;
}
export interface ComputerUseStopReceipt extends ComputerUseReceipt {
  terminalCause: string;
  stopConfirmed: boolean;
  effectVerified: false;
}

export interface ComputerUseRecoveryReceipt extends ComputerUseReceipt {
  actionId: string;
  status: "not_dispatched" | "dispatched_unverified" | "unknown";
  stopConfirmed: boolean;
}

export function supportsComputerUseEnd(hello: ComputerUseHello): boolean {
  const background = hello.capabilities.background;
  return isRecord(background) && background.sessionEnd === true;
}

export class ComputerUseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ComputerUseError";
  }
}

export function computerUseAction(value: string): value is ComputerUseAction {
  return (COMPUTER_USE_ACTIONS as readonly string[]).includes(value);
}

const maxScrollDelta = 2000;
export const scrollUsage = `For a scroll, use "action":{"type":"scroll","deltaY":-480} with a top-level element ref, or put window-pixel x and y inside action. deltaY is required and deltaX is optional. Both are integers from -${maxScrollDelta} to ${maxScrollDelta}.`;

function invalid(message = "The computer-use arguments are invalid."): never {
  throw new ComputerUseError("invalid_args", message);
}

export function boundedString(value: unknown, limit = 256): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0")
  );
}

export function isComputerUseObservationRegion(
  value: unknown,
): value is ComputerUseObservationRegion {
  if (!isRecord(value)) return false;
  const { x, y, width, height, fromEnd } = value;
  return (
    typeof x === "number" &&
    Number.isInteger(x) &&
    x >= 0 &&
    typeof y === "number" &&
    Number.isInteger(y) &&
    y >= 0 &&
    typeof width === "number" &&
    Number.isInteger(width) &&
    width >= 1 &&
    x + width <= 16384 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height >= 1 &&
    y + height <= 16384 &&
    (fromEnd === undefined || typeof fromEnd === "boolean") &&
    Object.keys(value).every((key) => ["x", "y", "width", "height", "fromEnd"].includes(key))
  );
}

export function sameComputerUseObservationRegion(
  a: ComputerUseObservationRegion | undefined,
  b: ComputerUseObservationRegion | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    (a.fromEnd === true) === (b.fromEnd === true)
  );
}

export function parseComputerUseArgs(
  action: ComputerUseAction,
  value: unknown,
): Record<string, unknown> {
  const args = value === undefined || value === null ? {} : value;
  if (!isRecord(args)) return invalid();
  const allowed: Record<ComputerUseAction, string[]> = {
    "computer.status": [],
    "computer.windows": [],
    "computer.bind": ["windowRef", "requireSessionEnd", "lease", "foregroundNavigationFallback"],
    "computer.preempt": [
      "windowRef",
      "preemptToken",
      "requireSessionEnd",
      "lease",
      "foregroundNavigationFallback",
    ],
    "computer.recover": ["actionId"],
    "computer.observe": ["sessionId", "screenshot", "full", "baseVersion", "region"],
    "computer.act": [
      "sessionId",
      "actionId",
      "observationId",
      "stateVersion",
      "ref",
      "action",
      "expect",
      "navigation",
    ],
    "computer.verify": ["sessionId", "actionId"],
    "computer.cancel": ["sessionId"],
    "computer.end": ["sessionId"],
    "computer.renew": ["sessionId"],
  };
  if (Object.keys(args).some((key) => !allowed[action].includes(key))) return invalid();
  if (action === "computer.bind" || action === "computer.preempt") {
    if (args.windowRef === undefined)
      throw new ComputerUseError(
        "window_selection_required",
        "Select an explicit background window before binding.",
      );
    if (!boundedString(args.windowRef)) return invalid();
    if (action === "computer.preempt" && !boundedString(args.preemptToken, 128)) return invalid();
    if (
      [args.requireSessionEnd, args.lease, args.foregroundNavigationFallback].some(
        (flag) => flag !== undefined && typeof flag !== "boolean",
      )
    )
      return invalid();
  }
  if (
    ![
      "computer.status",
      "computer.windows",
      "computer.bind",
      "computer.preempt",
      "computer.recover",
    ].includes(action) &&
    !boundedString(args.sessionId)
  )
    return invalid();
  if (action === "computer.observe") {
    if ([args.screenshot, args.full].some((v) => v !== undefined && typeof v !== "boolean"))
      return invalid();
    if (args.region !== undefined && !isComputerUseObservationRegion(args.region)) return invalid();
    if (
      args.baseVersion !== undefined &&
      (!Number.isSafeInteger(args.baseVersion) || Number(args.baseVersion) < 0)
    )
      return invalid();
  }
  if (
    (action === "computer.act" || action === "computer.verify" || action === "computer.recover") &&
    !boundedString(args.actionId, 100)
  )
    return invalid();
  if (action === "computer.act") {
    if (
      !boundedString(args.observationId) ||
      (args.ref !== undefined && !boundedString(args.ref)) ||
      !Number.isSafeInteger(args.stateVersion) ||
      (args.stateVersion as number) < 0 ||
      !isRecord(args.action)
    )
      return invalid();
    const input = args.action;
    const inputUsage = input.type === "scroll" ? scrollUsage : undefined;
    if (
      args.navigation !== undefined &&
      (typeof args.navigation !== "boolean" ||
        (args.navigation &&
          (input.type !== "click" ||
            !boundedString(args.ref) ||
            input.button === "right" ||
            input.clickCount === 2)))
    )
      return invalid();
    const keys: Record<string, string[]> = {
      setValue: ["value"],
      press: [],
      move: ["x", "y"],
      click: ["x", "y", "button", "clickCount"],
      drag: ["x", "y", "toX", "toY", "durationMs"],
      scroll: ["x", "y", "deltaX", "deltaY"],
      key: ["key", "modifiers"],
      type: ["text"],
      selectText: ["text", "prefix", "suffix", "selectionType"],
      performAction: ["action"],
    };
    if (typeof input.type !== "string" || !Object.hasOwn(keys, input.type))
      throw new ComputerUseError("unsupported_action", "This computer-use input is not supported.");
    if (
      Object.keys(input).some((key) => key !== "type" && !keys[input.type as string].includes(key))
    )
      return invalid(inputUsage);
    const coordinate = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 16384;
    if (["move", "click", "drag", "scroll"].includes(input.type)) {
      const hasCoordinate = input.x !== undefined || input.y !== undefined;
      if (hasCoordinate && (!coordinate(input.x) || !coordinate(input.y)))
        return invalid(inputUsage);
      if (!hasCoordinate && (!["click", "scroll"].includes(input.type) || !boundedString(args.ref)))
        return invalid(inputUsage);
    }
    if (
      input.type === "drag" &&
      (!coordinate(input.toX) ||
        !coordinate(input.toY) ||
        (input.durationMs !== undefined &&
          (!Number.isSafeInteger(input.durationMs) ||
            Number(input.durationMs) < 100 ||
            Number(input.durationMs) > 2000)))
    )
      return invalid();
    if (
      input.type === "click" &&
      ((input.button !== undefined && !["left", "right"].includes(String(input.button))) ||
        (input.clickCount !== undefined && input.clickCount !== 1 && input.clickCount !== 2))
    )
      return invalid();
    if (
      input.type === "scroll" &&
      ![input.deltaY, input.deltaX ?? 0].every(
        (v) => Number.isSafeInteger(v) && Math.abs(Number(v)) <= maxScrollDelta,
      )
    )
      return invalid(scrollUsage);
    if (
      ["setValue", "press", "selectText", "performAction"].includes(input.type) &&
      !boundedString(args.ref)
    )
      return invalid();
    if (
      input.type === "setValue" &&
      (typeof input.value !== "string" || input.value.length > 16384 || input.value.includes("\0"))
    )
      return invalid();
    if (input.type === "type" && !boundedString(input.text, 4096)) return invalid();
    if (
      input.type === "selectText" &&
      (!boundedString(input.text, 4096) ||
        [input.prefix, input.suffix].some(
          (v) => v !== undefined && (typeof v !== "string" || v.length > 4096 || v.includes("\0")),
        ) ||
        (input.selectionType !== undefined &&
          (typeof input.selectionType !== "string" ||
            !["text", "cursor_before", "cursor_after"].includes(input.selectionType))))
    )
      return invalid();
    if (input.type === "performAction" && !boundedString(input.action, 128)) return invalid();
    if (
      input.type === "key" &&
      (!boundedString(input.key, 32) ||
        (input.modifiers !== undefined &&
          (!Array.isArray(input.modifiers) ||
            input.modifiers.length > 4 ||
            new Set(input.modifiers).size !== input.modifiers.length ||
            !input.modifiers.every((v) =>
              ["command", "control", "alt", "shift"].includes(String(v)),
            ))))
    )
      return invalid();
    if (
      args.expect !== undefined &&
      (!isRecord(args.expect) ||
        Object.keys(args.expect).length === 0 ||
        Object.entries(args.expect).some(
          ([key, value]) =>
            !["role", "identifier", "title", "value", "contains"].includes(key) ||
            typeof value !== "string" ||
            value.length > 4096 ||
            value.includes("\0"),
        ))
    )
      return invalid();
  }
  return args;
}

export function parseComputerUseHello(value: unknown): ComputerUseHello {
  if (!isRecord(value) || value.protocolVersion !== COMPUTER_USE_PROTOCOL_VERSION)
    throw new ComputerUseError(
      "computer_protocol_mismatch",
      "The computer-use helper uses a different protocol version.",
    );
  if (
    !isRecord(value.permissions) ||
    typeof value.permissions.accessibility !== "boolean" ||
    typeof value.permissions.screenCapture !== "boolean" ||
    !isRecord(value.capabilities) ||
    !Array.isArray(value.capabilities.actions) ||
    !value.capabilities.actions.every((action) => typeof action === "string") ||
    (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0)) ||
    (value.instanceId !== undefined && !boundedString(value.instanceId, 128))
  )
    throw new ComputerUseError(
      "invalid_helper_response",
      "The computer-use helper returned invalid capabilities.",
    );
  return value as ComputerUseHello;
}

export function parseComputerUseReceipt(
  value: unknown,
  sessionId: string,
  actionId?: string,
): ComputerUseReceipt {
  if (
    !isRecord(value) ||
    value.sessionId !== sessionId ||
    (actionId !== undefined && value.actionId !== actionId) ||
    typeof value.status !== "string" ||
    typeof value.effectVerified !== "boolean"
  )
    throw new ComputerUseError(
      "invalid_computer_response",
      "The computer returned an invalid action receipt.",
    );
  return value as unknown as ComputerUseReceipt;
}

export function parseComputerUseObservation(
  value: unknown,
  sessionId: string,
): ComputerUseObservation {
  if (
    !isRecord(value) ||
    value.sessionId !== sessionId ||
    !boundedString(value.observationId) ||
    !Number.isSafeInteger(value.stateVersion) ||
    Number(value.stateVersion) < 0 ||
    !isRecord(value.validity) ||
    typeof value.validity.observedAt !== "number" ||
    !Number.isFinite(value.validity.observedAt) ||
    typeof value.validity.expiresAt !== "number" ||
    !Number.isFinite(value.validity.expiresAt) ||
    value.validity.expiresAt < value.validity.observedAt ||
    value.validity.expiresAt - value.validity.observedAt > 15.001 ||
    value.validity.maxAgeSeconds !== 15 ||
    typeof value.validity.clock !== "string" ||
    !Array.isArray(value.elements) ||
    value.elements.length > 512 ||
    !value.elements.every((item) => isRecord(item) && boundedString(item.ref)) ||
    new Set(value.elements.map((item) => (isRecord(item) ? item.ref : undefined))).size !==
      value.elements.length ||
    typeof value.complete !== "boolean" ||
    (value.region !== undefined &&
      (!isComputerUseObservationRegion(value.region) || value.delta === undefined))
  )
    throw new ComputerUseError(
      "invalid_helper_response",
      "The computer-use helper returned an invalid observation.",
    );
  if (value.delta !== undefined) {
    const delta = value.delta;
    if (
      !isRecord(delta) ||
      typeof delta.mode !== "string" ||
      !["full", "delta"].includes(delta.mode) ||
      !boundedString(delta.lineageId) ||
      delta.version !== value.stateVersion ||
      delta.complete !== value.complete ||
      ![delta.added, delta.changed, delta.removed].every(
        (refs) =>
          Array.isArray(refs) && refs.length <= 512 && refs.every((ref) => boundedString(ref)),
      ) ||
      Object.keys(delta).some(
        (key) =>
          ![
            "mode",
            "lineageId",
            "baseVersion",
            "version",
            "complete",
            "added",
            "changed",
            "removed",
          ].includes(key),
      )
    ) {
      throw new ComputerUseError(
        "invalid_helper_response",
        "The helper returned an invalid state delta.",
      );
    }
    const added = delta.added as string[],
      changed = delta.changed as string[],
      removed = delta.removed as string[];
    const all = [...added, ...changed, ...removed];
    const payload = new Set(
      value.elements.map((element) => (isRecord(element) ? element.ref : undefined)),
    );
    if (
      new Set(all).size !== all.length ||
      payload.size !== added.length + changed.length ||
      [...added, ...changed].some((ref) => !payload.has(ref)) ||
      (delta.mode === "full" &&
        (delta.baseVersion !== null || changed.length !== 0 || removed.length !== 0)) ||
      (delta.mode === "delta" &&
        (delta.complete !== true ||
          !Number.isSafeInteger(delta.baseVersion) ||
          Number(delta.baseVersion) < 0 ||
          Number(delta.version) !== Number(delta.baseVersion) + 1))
    ) {
      throw new ComputerUseError(
        "invalid_helper_response",
        "The state delta has inconsistent versions or element identities.",
      );
    }
  }
  return value as unknown as ComputerUseObservation;
}

/** The audit records the operation and sizes, never target content or model input. */
export function sanitizeComputerUseArgs(action: string, args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return { action, invalid: true };
  const input = isRecord(args.action) ? args.action : undefined;
  return {
    action,
    ...(boundedString(args.sessionId) ? { sessionId: args.sessionId } : {}),
    ...(boundedString(args.actionId, 100) ? { actionId: args.actionId } : {}),
    ...(input && typeof input.type === "string" ? { operation: input.type.slice(0, 32) } : {}),
    ...(input && typeof input.value === "string"
      ? { valueBytes: Buffer.byteLength(input.value) }
      : {}),
    ...(input && typeof input.text === "string"
      ? { textBytes: Buffer.byteLength(input.text) }
      : {}),
    ...(typeof args.screenshot === "boolean" ? { screenshot: args.screenshot } : {}),
  };
}
