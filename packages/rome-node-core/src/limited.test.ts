import { readFileSync } from "node:fs";
import { describe, expect, it, rs } from "@rstest/core";
import { COMPUTER_USE_OFF, createLimitedResponder } from "./limited.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, type Frame } from "./frame.js";
import type { OutboundEnvelope } from "./protocol.js";

const PEER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function setup() {
  const sent: OutboundEnvelope[] = [];
  const frames: Frame[] = [];
  const responder = createLimitedResponder(
    "RayBook",
    (message) => {
      sent.push(message);
      return true;
    },
    (frame) => {
      frames.push(frame);
      return true;
    },
  );
  return { responder, sent, frames };
}

const request = (action: string, args: unknown = {}) => ({ type: "request", action, args });
const requestFrame = (payload: unknown, body = new Uint8Array([1, 2, 3])): Frame => ({
  type: FRAME_TYPE.request,
  id: ID,
  peer: PEER,
  meta: encodeMeta(payload),
  body,
});

describe("limited responder", () => {
  it("answers system.info and says Computer use is off", () => {
    const { responder, sent } = setup();
    responder.receive({ id: "a", from: "caller", payload: request("system.info") });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      id: "a",
      to: "caller",
      payload: {
        type: "response",
        ok: true,
        result: { name: "RayBook", actions: [], computerUse: false, frameVersion: 1 },
      },
    });
    const result = (sent[0].payload as { result: Record<string, unknown> }).result;
    expect(typeof result.platform).toBe("string");
    // Without a transferVersion, rome-node cp stops before it opens a transfer.
    expect(result).not.toHaveProperty("transferVersion");
  });

  it.each([
    "exec",
    "fs.list",
    "transfer.open",
    "anything.else",
  ])("refuses %s with computer_use_off as a normal reply", (action) => {
    const { responder, sent } = setup();
    responder.receive({
      id: "b",
      from: "caller",
      payload: request(action, { command: "touch", args: ["/tmp/x"] }),
    });
    expect(sent).toEqual([{ id: "b", to: "caller", payload: COMPUTER_USE_OFF }]);
    expect(COMPUTER_USE_OFF).toMatchObject({
      ok: false,
      error: { code: "computer_use_off" },
    });
  });

  it.each([
    null,
    "x",
    [],
    { type: "response" },
    { type: "request" },
    { type: "request", action: 4 },
  ])("ignores a payload that is not a request: %j", (payload) => {
    const { responder, sent } = setup();
    responder.receive({ id: "c", from: "caller", payload });
    expect(sent).toEqual([]);
  });

  it("answers a request frame with a response frame, never running its body", () => {
    const { responder, frames } = setup();
    responder.receiveFrame(requestFrame(request("exec", { command: "id" })));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: FRAME_TYPE.response, id: ID, peer: PEER });
    expect(frames[0].body.byteLength).toBe(0);
    expect(decodeMeta(frames[0].meta)).toEqual(COMPUTER_USE_OFF);
  });

  it("answers a transfer.open frame with the error, so rome-node cp does not wait", () => {
    const { responder, frames } = setup();
    responder.receiveFrame(requestFrame(request("transfer.open", { direction: "pull" })));
    expect(decodeMeta(frames[0].meta)).toMatchObject({
      ok: false,
      error: { code: "computer_use_off" },
    });
  });

  it("answers system.info over frames too", () => {
    const { responder, frames } = setup();
    responder.receiveFrame(requestFrame(request("system.info")));
    expect(decodeMeta(frames[0].meta)).toMatchObject({ ok: true, result: { computerUse: false } });
  });

  it("ignores frames that are not requests", () => {
    const { responder, frames } = setup();
    responder.receiveFrame({ ...requestFrame(request("exec")), type: FRAME_TYPE.response });
    responder.receiveFrame(
      requestFrame({ type: "transfer", kind: "abort", code: "x", message: "y" }),
    );
    responder.receiveFrame({
      ...requestFrame(request("exec")),
      meta: new Uint8Array([0xff, 0xfe]),
    });
    expect(frames).toEqual([]);
  });

  it("has nothing to wait for on stop", async () => {
    const { responder } = setup();
    responder.disconnect();
    await expect(responder.idle()).resolves.toBeUndefined();
  });
});

describe("what the limited mode links", () => {
  // The mode's safety rests on no program or file code being reachable from it.
  const FORBIDDEN =
    /(?:^|\n)\s*(?:import|export)\s(?!type\b)[^;]*?from\s+["'](?:\.\/(?:executor|transfer|audit|connector|daemon[\w-]*|local|storage)\.js|node:(?:child_process|fs|fs\/promises|net|os\/exec)|child_process|fs|fs\/promises)["']/;
  it.each([
    "limited.ts",
    "limited-host.ts",
    "host-connection.ts",
  ])("%s imports no executor, transfer, file, or process code", (file) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(source).not.toMatch(FORBIDDEN);
    expect(source).not.toMatch(/\bspawn\b|\bexec(?:File)?Sync?\b|createExecutor/);
  });
  it("the check does catch a real import", () => {
    expect(`import { createExecutor } from "./executor.js";`).toMatch(FORBIDDEN);
    expect(`import type { HostAudit } from "./executor.js";`).not.toMatch(FORBIDDEN);
  });
});
