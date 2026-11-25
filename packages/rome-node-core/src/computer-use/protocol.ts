import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isUuid } from "../frame.js";

export const JSON_LIMIT = 256 * 1024;
export const PNG_LIMIT = 8 * 1024 * 1024;
const DIMENSION_LIMIT = 2048;
const PIXEL_LIMIT = 2048 * 1536;
const VALUE_LIMIT = 16_384;
const PNG_IHDR = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const wireErrorCodes = [
  "invalid_frame",
  "frame_limit",
  "invalid_request",
  "unsupported_version",
  "method_unavailable",
  "authentication_failed",
  "auth_required",
  "auth_failed",
  "consent_denied",
  "key_store_unavailable",
  "trusted_key_limit",
  "key_revoked",
  "connection_closed",
  "desktop_disabled",
  "console_unavailable",
  "accessibility_permission_required",
  "screen_recording_permission_required",
  "session_stopped",
  "busy",
  "window_unavailable",
  "window_already_bound",
  "window_coordinate_out_of_bounds",
  "window_focus_unavailable",
  "window_occluded",
  "process_identity_changed",
  "binding_unavailable",
  "binding_not_found",
  "element_unavailable",
  "key_unavailable",
  "action_unavailable",
  "invalid_value",
  "action_rejected",
  "action_outcome_unknown",
  "capture_failed",
  "capture_limit",
  "internal_error",
] as const;

type WireErrorCode = (typeof wireErrorCodes)[number];
type ErrorCode =
  | WireErrorCode
  | "computer_use_unsupported_platform"
  | "computer_use_helper_missing"
  | "invalid_helper_bundle"
  | "socket_path_limit"
  | "unsafe_state_directory"
  | "socket_unavailable"
  | "startup_timeout"
  | "request_timeout"
  | "request_aborted";

const wireErrors = new Set<unknown>(wireErrorCodes);

export class ComputerUseError extends Error {
  constructor(
    readonly code: ErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ComputerUseError";
  }

  get retryable(): boolean {
    return this.code === "busy" || this.code === "request_timeout";
  }

  get actionOutcomeUnknown(): boolean {
    return this.code === "action_outcome_unknown";
  }
}

const actions = ["press", "set_value", "increment", "decrement"] as const;
type Action = (typeof actions)[number];
type Value = string | boolean | number;
const actionNames = new Set<unknown>(actions);

type AXAction = { element: string } & (
  | { action: "set_value"; value: Value }
  | { action: Exclude<Action, "set_value">; value?: never }
);

type Point = { x: number; y: number };
type Button = "left" | "right" | "middle";
type Modifiers = ("command" | "control" | "option" | "shift")[];
type InputAction =
  | ({ modifiers?: Modifiers } & (
      | ({ action: "click"; button?: Button; clickCount?: number } & Point)
      | ({ action: "move" } & Point)
      | ({ action: "drag"; toX: number; toY: number; button?: Button; steps?: number } & Point)
      | ({ action: "scroll"; deltaX: number; deltaY: number } & Point)
      | { action: "key_press"; key: string }
    ))
  | { action: "type_text"; text: string };

export type ActParams = { binding: string } & (AXAction | InputAction);

export type ConsentMode = "session_only" | "persistent_only" | "session_or_persistent";
type Locale = "en" | "ja" | "zh-Hans" | "zh-Hant";

export interface ControllerClaim {
  publicKey: string;
  label: string;
  scope: "remote" | "local";
}

interface HelperIdentity {
  instance: string;
  helperPid: number;
  helperProof: string;
}

interface ConsentChallenge {
  status: "challenge_required";
  challenge: string;
  fingerprint: string;
  locale: Locale;
}

interface SessionGrant {
  auth: "session";
  locale: Locale;
}

interface ControllerGrant {
  auth: "session" | "persistent";
  locale: Locale;
  fingerprint: string;
  enrolled: boolean;
  label: string;
  scope: ControllerClaim["scope"];
}

export interface ScreenshotDescriptor {
  mimeType: "image/png";
  width: number;
  height: number;
  bytes: number;
}

interface WindowRecord {
  window: number;
  appName: string;
  bundleName: string;
  bundleId: string;
  title: string;
  bounds: [number, number, number, number];
}

interface TreeNode {
  ref: string;
  role: string;
  actions: Action[];
  children: TreeNode[];
  title?: string;
  description?: string;
  value?: Value;
  valueTruncated?: true;
}

type StopResult = { stop: "cancel_requested" | "stop_confirmed"; reason: WireErrorCode };
type StopStatus = { stop: "running"; reason?: never } | StopResult;

export interface RequestParams {
  hello: {
    nonce: string;
    proof: string;
    locale?: string;
    consentMode?: ConsentMode;
    controller?: ControllerClaim;
  };
  authorize: { signature: string };
  status: undefined;
  windows: { application?: string } | undefined;
  bind: { window: number };
  unbind: { binding: string };
  observe: { binding: string; element?: string; screenshot?: boolean };
  act: ActParams;
  cancel: undefined;
  stop: undefined;
}

export interface Results {
  hello: HelperIdentity & (SessionGrant | ConsentChallenge);
  authorize: ControllerGrant;
  status: { instance: string } & StopStatus;
  windows: { windows: WindowRecord[] };
  bind: { binding: string; window: WindowRecord };
  unbind: { binding: string; released: true };
  observe: {
    binding: string;
    tree: TreeNode;
    truncated: boolean;
    refTTLms: number;
    screenshot?: ScreenshotDescriptor;
  };
  act: { binding: string; dispatched: true };
  cancel: StopResult;
  stop: StopResult;
}

export type Method = keyof RequestParams;
type Request<M extends Method> = { v: 1; id: string; method: M; params?: RequestParams[M] };
type Response<M extends Method> =
  | { v: 1; id: string; ok: true; result: Results[M] }
  | { v: 1; id: string | null; ok: false; error: { code: WireErrorCode } };

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);
}

function isNonemptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isId(value: unknown): value is string {
  return isNonemptyString(value) && Buffer.byteLength(value) <= 64;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 1 && value <= max;
}

function isPid(value: unknown): value is number {
  return isPositiveInteger(value, 0x7fffffff);
}

function isWindowId(value: unknown): value is number {
  return isPositiveInteger(value, 0xffffffff);
}

function isValue(value: unknown): value is Value {
  return (
    (isString(value) && Buffer.byteLength(value) <= VALUE_LIMIT) ||
    typeof value === "boolean" ||
    isNumber(value)
  );
}

function hasOnlyKeys(value: JsonObject, ...keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function decodeBase64(value: unknown, size = 32): Buffer | undefined {
  if (!isString(value) || value.length !== Math.ceil(size / 3) * 4) return;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === size && bytes.toString("base64") === value) return bytes;
}

const locales = new Set<unknown>(["en", "ja", "zh-Hans", "zh-Hant"]);
const consentModes = new Set<unknown>(["session_only", "persistent_only", "session_or_persistent"]);

function isScope(value: unknown): boolean {
  return value === "remote" || value === "local";
}

function isFingerprint(value: unknown): boolean {
  return isString(value) && /^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/.test(value);
}

// Match the helper's canonical Ed25519 encoding and small-order checks.
const smallOrderY = new Set([
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "JuiVj8KyJ7BFw/SJ8u+Y8NXfrAXTxjM5sTgCiG1T/AU=",
  "xxdqcD1N2E+6PAt2DRBnDyogU/osOczGTsf9d5KsA3o=",
]);
const fieldModulusMinusOne = Buffer.from(
  "7P///////////////////////////////////////38=",
  "base64",
).reverse();

function isControllerKey(value: unknown): boolean {
  const y = decodeBase64(value);
  if (!y) return false;
  y[31] &= 0x7f;
  return !smallOrderY.has(y.toString("base64")) && y.reverse().compare(fieldModulusMinusOne) < 0;
}

function isController(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, "publicKey", "label", "scope") &&
    isControllerKey(value.publicKey) &&
    isLabel(value.label) &&
    isScope(value.scope)
  );
}

function isLabel(value: unknown): boolean {
  return (
    isString(value) &&
    /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/u.test(value)
  );
}

const buttons = new Set<unknown>(["left", "right", "middle"]);
const modifiers = new Set<unknown>(["command", "control", "option", "shift"]);
const namedKeys =
  /^(?:return|enter|tab|escape|backspace|delete|space|up|down|left|right|home|end|page_up|page_down|f(?:[1-9]|1[0-2]))$/i;
const graphemes = new Intl.Segmenter();

function isKey(value: unknown): boolean {
  return (
    isNonemptyString(value) &&
    (namedKeys.test(value) || (value.length <= 16 && [...graphemes.segment(value)].length === 1))
  );
}

function isDelta(value: unknown): value is number {
  return isNumber(value) && Math.abs(value) <= 2000;
}

function isAct(value: unknown): boolean {
  if (!isObject(value) || !isUuid(value.binding)) return false;
  const { action, element, x, y, button, clickCount, toX, toY, steps, deltaX, deltaY, key, text } =
    value;
  if (actionNames.has(action)) {
    return (
      hasOnlyKeys(value, "binding", "action", "element", "value") &&
      isNonemptyString(element) &&
      (action === "set_value" ? isValue(value.value) : value.value === undefined)
    );
  }
  if (action === "type_text") {
    return (
      hasOnlyKeys(value, "binding", "action", "text") &&
      isNonemptyString(text) &&
      Buffer.byteLength(text) <= VALUE_LIMIT
    );
  }
  const names = value.modifiers;
  if (
    names !== undefined &&
    (!Array.isArray(names) ||
      names.length > 4 ||
      !names.every((name) => modifiers.has(name)) ||
      new Set(names).size !== names.length)
  )
    return false;
  const keys = ["binding", "action", "modifiers"];
  if (action === "key_press") return hasOnlyKeys(value, ...keys, "key") && isKey(key);
  if (!isNumber(x) || !isNumber(y)) return false;
  keys.push("x", "y");
  switch (action) {
    case "move":
      return hasOnlyKeys(value, ...keys);
    case "click":
      return (
        hasOnlyKeys(value, ...keys, "button", "clickCount") &&
        (button === undefined || buttons.has(button)) &&
        (clickCount === undefined || isPositiveInteger(clickCount, 3))
      );
    case "drag":
      return (
        hasOnlyKeys(value, ...keys, "toX", "toY", "button", "steps") &&
        isNumber(toX) &&
        isNumber(toY) &&
        (button === undefined || buttons.has(button)) &&
        (steps === undefined || isPositiveInteger(steps, 60))
      );
    case "scroll":
      return (
        hasOnlyKeys(value, ...keys, "deltaX", "deltaY") &&
        isDelta(deltaX) &&
        isDelta(deltaY) &&
        (Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5)
      );
    default:
      return false;
  }
}

function isWindow(value: unknown): boolean {
  if (!isObject(value)) return false;
  const { window, appName, bundleName, bundleId, title, bounds } = value;
  return (
    isWindowId(window) &&
    [appName, bundleName, bundleId, title].every(isString) &&
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every(isNumber) &&
    bounds[2] > 0 &&
    bounds[3] > 0
  );
}

function isTree(value: unknown): boolean {
  const nodes = [value];
  while (nodes.length) {
    const node = nodes.pop();
    if (
      !isObject(node) ||
      !isNonemptyString(node.ref) ||
      !isNonemptyString(node.role) ||
      !Array.isArray(node.actions) ||
      !node.actions.every((action) => actionNames.has(action)) ||
      !Array.isArray(node.children) ||
      (node.title !== undefined && !isString(node.title)) ||
      (node.description !== undefined && !isString(node.description)) ||
      (node.value !== undefined && !isValue(node.value)) ||
      (node.valueTruncated !== undefined && (node.valueTruncated !== true || !isString(node.value)))
    )
      return false;
    for (const child of node.children) nodes.push(child);
  }
  return true;
}

function isStopped(result: JsonObject): boolean {
  return (
    (result.stop === "cancel_requested" || result.stop === "stop_confirmed") &&
    wireErrors.has(result.reason)
  );
}

function isScreenshot(value: unknown): value is ScreenshotDescriptor {
  if (!isObject(value)) return false;
  const { mimeType, width, height, bytes } = value;
  return (
    mimeType === "image/png" &&
    isPositiveInteger(width, DIMENSION_LIMIT) &&
    isPositiveInteger(height, DIMENSION_LIMIT) &&
    width * height <= PIXEL_LIMIT &&
    isPositiveInteger(bytes, PNG_LIMIT) &&
    bytes >= 33
  );
}

const resultValidators: Record<Method, (result: JsonObject) => boolean> = {
  hello: (result) => {
    const { instance, helperPid, helperProof, locale, auth, status, challenge, fingerprint } =
      result;
    if (
      !isUuid(instance) ||
      !isPid(helperPid) ||
      !decodeBase64(helperProof) ||
      !locales.has(locale)
    )
      return false;
    const keys = ["instance", "helperPid", "helperProof", "locale"];
    return status === "challenge_required"
      ? hasOnlyKeys(result, ...keys, "status", "challenge", "fingerprint") &&
          !!decodeBase64(challenge) &&
          isFingerprint(fingerprint)
      : hasOnlyKeys(result, ...keys, "auth") && auth === "session";
  },
  authorize: (result) => {
    const { auth, locale, fingerprint, enrolled, label, scope } = result;
    return (
      hasOnlyKeys(result, "auth", "locale", "fingerprint", "enrolled", "label", "scope") &&
      (auth === "session" || auth === "persistent") &&
      locales.has(locale) &&
      isFingerprint(fingerprint) &&
      typeof enrolled === "boolean" &&
      (auth === "persistent" || !enrolled) &&
      isLabel(label) &&
      isScope(scope)
    );
  },
  status: (result) =>
    isUuid(result.instance) &&
    (result.stop === "running" ? result.reason === undefined : isStopped(result)),
  windows: ({ windows }) => Array.isArray(windows) && windows.every(isWindow),
  bind: ({ binding, window }) => isUuid(binding) && isWindow(window),
  unbind: ({ binding, released }) => isUuid(binding) && released === true,
  observe: ({ binding, tree, truncated, refTTLms, screenshot }) =>
    isUuid(binding) &&
    isTree(tree) &&
    typeof truncated === "boolean" &&
    isPositiveInteger(refTTLms) &&
    (screenshot === undefined || isScreenshot(screenshot)),
  act: ({ binding, dispatched }) => isUuid(binding) && dispatched === true,
  cancel: isStopped,
  stop: isStopped,
};

const paramsValidators: Record<Method, (params: unknown) => boolean> = {
  hello: (params) =>
    isObject(params) &&
    hasOnlyKeys(params, "nonce", "proof", "locale", "consentMode", "controller") &&
    !!decodeBase64(params.nonce) &&
    !!decodeBase64(params.proof) &&
    (params.locale === undefined || isString(params.locale)) &&
    (params.consentMode === undefined || consentModes.has(params.consentMode)) &&
    (params.controller === undefined
      ? params.consentMode === undefined || params.consentMode === "session_only"
      : isController(params.controller)),
  authorize: (params) =>
    isObject(params) && hasOnlyKeys(params, "signature") && !!decodeBase64(params.signature, 64),
  status: (params) => params === undefined,
  windows: (params) =>
    params === undefined ||
    (isObject(params) &&
      hasOnlyKeys(params, "application") &&
      (params.application === undefined || isString(params.application))),
  bind: (params) => isObject(params) && hasOnlyKeys(params, "window") && isWindowId(params.window),
  unbind: (params) => isObject(params) && hasOnlyKeys(params, "binding") && isUuid(params.binding),
  observe: (params) =>
    isObject(params) &&
    hasOnlyKeys(params, "binding", "element", "screenshot") &&
    isUuid(params.binding) &&
    (params.element === undefined || isNonemptyString(params.element)) &&
    (params.screenshot === undefined || typeof params.screenshot === "boolean"),
  act: isAct,
  cancel: (params) => params === undefined,
  stop: (params) => params === undefined,
};

export function requestParams<M extends Method>(method: M, params: unknown): RequestParams[M] {
  if (!Object.hasOwn(paramsValidators, method) || !paramsValidators[method](params)) {
    throw new ComputerUseError("invalid_request");
  }
  return params as RequestParams[M];
}

export function makeRequest<M extends Method>(
  id: string,
  method: M,
  params: RequestParams[M],
): Request<M> {
  if (!isId(id)) {
    throw new ComputerUseError("invalid_request");
  }
  requestParams(method, params);
  return params === undefined ? { v: 1, id, method } : { v: 1, id, method, params };
}

export function parseResponse<M extends Method>(message: JsonObject, method?: M): Response<M> {
  const { v, id, ok, result, error } = message;
  if (
    v === 1 &&
    ok === false &&
    (isId(id) || id === null) &&
    hasOnlyKeys(message, "v", "id", "ok", "error") &&
    isObject(error) &&
    hasOnlyKeys(error, "code") &&
    wireErrors.has(error.code)
  ) {
    return message as Response<M>;
  }
  if (
    v === 1 &&
    ok === true &&
    isId(id) &&
    method &&
    hasOnlyKeys(message, "v", "id", "ok", "result") &&
    isObject(result) &&
    (method === "observe" || !Object.hasOwn(result, "screenshot")) &&
    resultValidators[method](result)
  ) {
    return message as Response<M>;
  }
  throw new ComputerUseError("invalid_frame");
}

export function screenshotFor(
  message: JsonObject,
  binaryLength: number,
): ScreenshotDescriptor | undefined {
  if (
    message.ok === true &&
    isObject(message.result) &&
    Object.hasOwn(message.result, "screenshot")
  ) {
    const screenshot = message.result.screenshot;
    if (
      message.v === 1 &&
      isId(message.id) &&
      hasOnlyKeys(message, "v", "id", "ok", "result") &&
      isScreenshot(screenshot) &&
      screenshot.bytes === binaryLength
    )
      return screenshot;
    throw new ComputerUseError("invalid_frame");
  }
  if (binaryLength !== 0) throw new ComputerUseError("invalid_frame");
}

export function checkPng(bytes: Buffer, { width, height }: ScreenshotDescriptor): void {
  if (
    !bytes.subarray(0, PNG_IHDR.length).equals(PNG_IHDR) ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  ) {
    throw new ComputerUseError("invalid_frame");
  }
}

interface HandshakeContext {
  secret: Buffer;
  nonce: Buffer;
  hostPid: number;
}

type ProofRole = ["host"] | ["helper", helperPid: number, instance: string];

export function createProof(context: HandshakeContext, ...role: ProofRole): string {
  const { secret, nonce, hostPid } = context;
  const [name, helperPid, instance] = role;
  if (
    secret.length !== 32 ||
    nonce.length !== 32 ||
    !isPid(hostPid) ||
    (name === "helper" && (!isPid(helperPid) || !isUuid(instance)))
  ) {
    throw new ComputerUseError("authentication_failed");
  }
  const fields = ["rome-computer-use-v1", name, hostPid];
  const encodedNonce = nonce.toString("base64");
  if (name === "host") fields.push(encodedNonce);
  else fields.push(helperPid, encodedNonce, instance);
  return createHmac("sha256", secret).update(fields.join("\n")).digest("base64");
}

export function verifyProof(proof: string, context: HandshakeContext, ...role: ProofRole): boolean {
  const actual = decodeBase64(proof);
  return (
    actual !== undefined &&
    timingSafeEqual(actual, Buffer.from(createProof(context, ...role), "base64"))
  );
}

export function controllerFingerprint(publicKey: string): string {
  const hex = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  return hex.slice(0, 32).toUpperCase().match(/.{4}/g)!.join("-");
}

export function authorizationPayload(
  hello: HelperIdentity & ConsentChallenge,
  hostPid: number,
  controller: ControllerClaim,
  mode: ConsentMode = "session_only",
): Buffer {
  return Buffer.from(
    [
      "rome-computer-use-auth-v1",
      hello.instance,
      hello.helperPid,
      hostPid,
      hello.challenge,
      controller.publicKey,
      controller.scope,
      mode,
    ].join("\n"),
  );
}
