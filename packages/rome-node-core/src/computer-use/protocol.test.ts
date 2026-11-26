import { describe, expect, it } from "@rstest/core";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { encodeFrame } from "./frames.js";
import { RELEASE_SIGNING_REQUIREMENT } from "./launch.js";
import {
  type ActParams,
  authorizationPayload,
  ComputerUseError,
  controllerFingerprint,
  createProof,
  makeRequest,
  type Method,
  parseResponse,
  type RequestParams,
  type Results,
  verifyProof,
} from "./protocol.js";

const binding = "0f8fad5b-d9cb-469f-a165-70867728950e";
const instance = "7C9E6679-7425-40DE-944B-E07FC1F90AE7";
const mac = Buffer.alloc(32, 0xff).toString("base64");
const controller = {
  publicKey: Buffer.from(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ).toString("base64"),
  label: "Rome Node CLI",
  scope: "remote",
} as const;
const fingerprint = "21FE-31DF-A154-A261-626B-F854-046F-D227";
const window: Results["bind"]["window"] = {
  window: 7,
  appName: "Notes",
  bundleName: "Notes",
  bundleId: "com.apple.Notes",
  title: "",
  bounds: [-40, 10, 512, 384],
};
const tree = {
  ref: "r",
  role: "AXButton",
  actions: ["press"],
  children: [],
  title: "Next",
  value: false,
};

const params: RequestParams = {
  hello: {
    nonce: mac,
    proof: mac,
    locale: "ja-JP",
    consentMode: "session_or_persistent",
    controller,
  },
  authorize: { signature: Buffer.alloc(64).toString("base64") },
  status: undefined,
  windows: { application: "Notes" },
  bind: { window: 7 },
  unbind: { binding },
  observe: { binding, element: "r", screenshot: false },
  act: { binding, element: "r", action: "press" },
  cancel: undefined,
  stop: undefined,
};

const results = {
  hello: { instance, helperPid: 123, helperProof: mac, auth: "session", locale: "ja" },
  authorize: {
    auth: "persistent",
    fingerprint,
    enrolled: true,
    label: controller.label,
    scope: "remote",
    locale: "ja",
  },
  status: { instance, stop: "running" },
  windows: { windows: [window] },
  bind: { binding, window },
  unbind: { binding, released: true },
  observe: {
    binding,
    tree: { ...tree, value: "long text", valueTruncated: true },
    truncated: true,
    refTTLms: 15_000,
  },
  act: { binding, dispatched: true },
  cancel: { stop: "cancel_requested", reason: "session_stopped" },
  stop: { stop: "stop_confirmed", reason: "key_revoked" },
};

const invalidParams = {
  hello: [
    { nonce: mac.replace("/", "_"), proof: mac },
    { nonce: mac.slice(0, -1), proof: mac },
    { nonce: mac, proof: mac, source: "Unverified" },
    { nonce: mac, proof: mac, locale: 123 },
    { nonce: mac, proof: mac, consentMode: "persistent_only" },
    { ...params.hello, consentMode: "always" },
    { ...params.hello, controller: { ...controller, scope: "other" } },
    { ...params.hello, controller: { ...controller, label: "\u2066  " } },
    { ...params.hello, controller: { ...controller, publicKey: "bad" } },
    {
      ...params.hello,
      controller: { ...controller, publicKey: Buffer.alloc(32).toString("base64") },
    },
  ],
  authorize: [{ signature: mac }, { signature: null }, {}],
  status: [{}, null],
  windows: [{ application: 1 }, { other: "Notes" }],
  bind: [{ window: 0 }, { window: 2 ** 32 }, { window: 1.5 }],
  unbind: [{ binding: "wrong" }],
  observe: [{ binding: "root" }, { binding, screenshot: 1 }, { binding, element: "" }],
  act: [
    { ...params.act, element: "" },
    { ...params.act, action: "click" },
    { ...params.act, value: null },
    { ...params.act, action: "set_value" },
    { ...params.act, action: "set_value", value: "🌱".repeat(4097) },
    { ...params.act, action: "set_value", value: Infinity },
  ],
  cancel: [{}, true],
  stop: [{}, true],
} satisfies Record<Method, unknown[]>;

const invalidResults = {
  hello: [
    { ...results.hello, helperPid: -1 },
    { ...results.hello, instance: 123 },
    { ...results.hello, helperProof: "short" },
    { ...results.hello, auth: "persistent" },
    { ...results.hello, locale: "ja-JP" },
    { ...results.hello, pid: 123, proof: mac },
    { ...results.hello, status: "challenge_required", challenge: mac, fingerprint },
  ],
  authorize: [
    { ...results.authorize, auth: "session", enrolled: true },
    { ...results.authorize, enrolled: null },
    { ...results.authorize, fingerprint: fingerprint.toLowerCase() },
  ],
  status: [
    { instance, stop: "paused" },
    { instance, stop: "stop_confirmed" },
  ],
  windows: [
    { windows: [{ ...window, bounds: [0, 1, -2, 3] }] },
    { windows: [{ ...window, bundleId: 5 }] },
  ],
  bind: [
    { ...results.bind, binding: "not-uuid" },
    { ...results.bind, window: 7 },
  ],
  unbind: [{ binding, released: false }],
  observe: [
    { ...results.observe, refTTLms: 0 },
    { ...results.observe, truncated: 0 },
    { ...results.observe, tree: { ...tree, children: [{ ...tree, actions: ["click"] }] } },
    { ...results.observe, tree: { ...tree, value: {} } },
    { ...results.observe, tree: { ...tree, valueTruncated: true } },
    { ...results.observe, tree: { ...tree, value: "abc", valueTruncated: false } },
    { ...results.observe, screenshot: { mimeType: "image/jpeg", width: 1, height: 1, bytes: 33 } },
  ],
  act: [
    { ...results.act, dispatched: false },
    { ...results.act, binding: "" },
  ],
  cancel: [
    { stop: "running", reason: "session_stopped" },
    { stop: "stop_confirmed", reason: "unknown" },
  ],
  stop: [{ stop: "stop_confirmed" }],
} satisfies Record<Method, unknown[]>;

describe("Computer Use v1 protocol", () => {
  it.each(Object.keys(params) as Method[])("validates %s requests and replies", (method) => {
    const request = makeRequest("1", method, params[method]);
    expect(request).toEqual(
      params[method] === undefined
        ? { v: 1, id: "1", method }
        : { v: 1, id: "1", method, params: params[method] },
    );
    for (const input of invalidParams[method]) {
      expect(() => makeRequest("1", method, input as never)).toThrow("invalid_request");
    }
    const message = { v: 1, id: "1", ok: true, result: results[method] };
    expect(parseResponse(message, method)).toEqual(message);
    for (const result of invalidResults[method]) {
      expect(() => parseResponse({ ...message, result }, method)).toThrow("invalid_frame");
    }
  });

  it("bounds IDs and action values by UTF-8 byte length", () => {
    const id = "🌱".repeat(16);
    expect(makeRequest(id, "windows", undefined)).toEqual({ v: 1, id, method: "windows" });
    expect(() => makeRequest(`${id}a`, "status", undefined)).toThrow("invalid_request");
    expect(() => makeRequest("", "status", undefined)).toThrow("invalid_request");
    expect(() => makeRequest("\ud800", "status", undefined)).toThrow("invalid_request");
    expect(makeRequest("1", "observe", { binding }).params).toEqual({ binding });
    for (const action of ["press", "increment", "decrement"] as const) {
      expect(makeRequest("1", "act", { binding, element: "ref", action }).params?.action).toBe(
        action,
      );
    }
    for (const value of ["", "🌱".repeat(4096), false, -1.25]) {
      expect(
        makeRequest("1", "act", { binding, element: "ref", action: "set_value", value }).params,
      ).toMatchObject({ value });
    }
  });

  it("recognizes the stable failures and distinguishes unknown action outcomes", () => {
    for (const code of [
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
    ]) {
      const failure = { v: 1, id: "1", ok: false, error: { code } };
      expect(parseResponse(failure, "act")).toEqual(failure);
    }
    expect(
      parseResponse({ v: 1, id: null, ok: false, error: { code: "frame_limit" } }),
    ).toMatchObject({ id: null });
    expect(() => parseResponse({ v: 1, id: "1", ok: false, error: { code: "other" } })).toThrow(
      "invalid_frame",
    );
    expect(() => parseResponse({ v: 2, id: "1", ok: false, error: { code: "busy" } })).toThrow(
      "invalid_frame",
    );
    expect(() =>
      parseResponse({ v: 1, id: null, ok: true, result: results.status }, "status"),
    ).toThrow("invalid_frame");
    expect(() => parseResponse({ v: 1, event: "stop", ...results.stop }, "status")).toThrow(
      "invalid_frame",
    );
    expect(new ComputerUseError("busy").retryable).toBe(true);
    expect(new ComputerUseError("action_outcome_unknown")).toMatchObject({
      retryable: false,
      actionOutcomeUnknown: true,
    });
  });
});

it("authenticates both roles with the exact v1 HMAC transcript", () => {
  const secret = Buffer.alloc(32, 0xa1);
  const nonce = Buffer.alloc(32, 0xb2);
  const context = { secret, nonce, hostPid: 12 };
  const b64 = nonce.toString("base64");
  const expected = (transcript: string) =>
    createHmac("sha256", secret).update(transcript).digest("base64");
  const host = createProof(context, "host");
  const helper = createProof(context, "helper", 34, instance);
  expect(host).toBe(expected(`rome-computer-use-v1\nhost\n12\n${b64}`));
  expect(helper).toBe(expected(`rome-computer-use-v1\nhelper\n12\n34\n${b64}\n${instance}`));
  expect(verifyProof(host, context, "host")).toBe(true);
  expect(verifyProof(helper, context, "helper", 34, instance)).toBe(true);
  expect(verifyProof(host, context, "helper", 34, instance)).toBe(false);
  expect(verifyProof(helper, context, "helper", 34, binding)).toBe(false);
  expect(verifyProof(helper, context, "helper", 35, instance)).toBe(false);
  expect(verifyProof(host, { ...context, hostPid: 13 }, "host")).toBe(false);
  expect(verifyProof(host, { ...context, secret: Buffer.alloc(32) }, "host")).toBe(false);
  expect(verifyProof("not-base64", context, "host")).toBe(false);
});

it("serializes hello and constructs the exact controller authorization transcript", () => {
  const frame = encodeFrame(makeRequest("1", "hello", params.hello));
  expect(JSON.parse(frame.subarray(8).toString())).toEqual({
    v: 1,
    id: "1",
    method: "hello",
    params: params.hello,
  });
  const hello = {
    instance,
    helperPid: 34,
    helperProof: mac,
    status: "challenge_required",
    challenge: mac,
    fingerprint,
    locale: "ja",
  } as const;
  const reply = { v: 1, id: "1", ok: true, result: hello };
  expect(parseResponse(reply, "hello")).toEqual(reply);
  expect(() =>
    parseResponse({ ...reply, result: { ...hello, challenge: "short" } }, "hello"),
  ).toThrow("invalid_frame");
  expect(controllerFingerprint(controller.publicKey)).toBe(fingerprint);
  expect(authorizationPayload(hello, 12, controller).toString()).toBe(
    `rome-computer-use-auth-v1\n${instance}\n34\n12\n${mac}\n${controller.publicKey}\nremote\nsession_only`,
  );
});

it("serializes every input action and rejects invalid fields before dispatch", () => {
  const point = { binding, x: 10, y: 20 };
  const inputs: ActParams[] = [
    { ...point, action: "click", button: "middle", clickCount: 3, modifiers: ["command"] },
    { ...point, action: "move" },
    { ...point, action: "drag", toX: 0, toY: 1, steps: 60 },
    { ...point, action: "scroll", deltaX: -0.5, deltaY: 2000 },
    { binding, action: "key_press", key: "F12", modifiers: ["shift", "option"] },
    { binding, action: "key_press", key: "👩‍💻" },
    { binding, action: "type_text", text: "🌱".repeat(4096) },
  ];
  for (const input of inputs) {
    const frame = encodeFrame(makeRequest("1", "act", input));
    expect(JSON.parse(frame.subarray(8).toString()).params).toEqual(input);
  }
  for (const invalid of [
    { ...inputs[0], clickCount: 4 },
    { ...inputs[0], button: "other" },
    { ...inputs[0], element: "r" },
    { ...inputs[1], x: Infinity },
    { ...inputs[2], steps: 0 },
    { ...inputs[2], toY: undefined },
    { ...inputs[3], deltaX: 0, deltaY: -0.499 },
    { ...inputs[3], deltaY: 2000.1 },
    { ...inputs[4], modifiers: ["shift", "shift"] },
    { ...inputs[4], modifiers: ["alt"] },
    { ...inputs[4], key: "f13" },
    { ...inputs[6], text: "" },
    { ...inputs[6], text: "🌱".repeat(4097) },
  ]) {
    expect(() => makeRequest("1", "act", invalid as ActParams)).toThrow("invalid_request");
  }
});

it("pins the same Rome Developer ID requirement as the native release gate", () => {
  const script = readFileSync(new URL("../../scripts/computer-use.swift", import.meta.url), "utf8");
  const native = script.match(/^let releaseSigningRequirement = #"(.*)"#$/m)?.[1];
  expect(RELEASE_SIGNING_REQUIREMENT).toBe(native);
  for (const pin of [
    'identifier "com.rome.computer-use"',
    "anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6]",
    "certificate leaf[field.1.2.840.113635.100.6.1.13]",
    'certificate leaf[subject.OU] = "4YWXB26F39"',
  ])
    expect(RELEASE_SIGNING_REQUIREMENT).toContain(pin);
  expect(script).toContain("let expression = release ? releaseSigningRequirement");
});
