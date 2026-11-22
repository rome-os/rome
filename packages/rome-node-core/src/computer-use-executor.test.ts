import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { isRecord } from "./actions.js";
import { createComputerUseHost } from "./computer-use.js";
import { createExecutor } from "./executor.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, type Frame } from "./frame.js";
import type { OutboundEnvelope } from "./protocol.js";

const owner = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const requestId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function result(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result))
    throw new Error("Expected a successful response.");
  return response.result;
}

async function fixture() {
  const stateDir = await mkdtemp("/tmp/rome-cua-executor-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const nativeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let dispatch: () => Promise<unknown> = async () => ({
    status: "dispatched_unverified",
    effectVerified: false,
    eventsPosted: 0,
    operationsDispatched: 1,
  });
  const host = createComputerUseHost({
    stateDir,
    platform: "darwin",
    native: {
      async call(method, params) {
        nativeCalls.push({ method, params });
        if (method === "hello")
          return {
            protocolVersion: 1,
            permissions: { accessibility: true, screenCapture: true },
            capabilities: { actions: ["setValue"] },
            execution: { busy: false },
          };
        if (method === "windows") return { windows: [{ windowRef: "opaque-window" }] };
        if (method === "bind") return { sessionId: params.sessionId, status: "bound" };
        if (method === "observe")
          return {
            sessionId: params.sessionId,
            observationId: "opaque-observation",
            stateVersion: 1,
            validity: {
              observedAt: Date.now() / 1000,
              expiresAt: Date.now() / 1000 + 14,
              maxAgeSeconds: 15,
              clock: "remote_wall_time",
            },
            complete: true,
            elements: [{ ref: "opaque-element", value: "PRIVATE AX CONTENT" }],
            ...(params.screenshot
              ? {
                  screenshot: {
                    mimeType: "image/png",
                    width: 1,
                    height: 1,
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mL8AAAAASUVORK5CYII=",
                  },
                }
              : {}),
          };
        if (method === "act") {
          const receipt = await dispatch();
          return isRecord(receipt)
            ? { sessionId: params.sessionId, actionId: params.actionId, ...receipt }
            : receipt;
        }
        if (method === "verify") return { ...params, status: "verified", effectVerified: true };
        if (method === "cancel") return { status: "cancelled", terminalCause: "cancelled" };
        throw new Error("Unexpected native method");
      },
    },
  });
  const starts: Array<{ action: string; fields: Record<string, unknown>; content: unknown }> = [];
  const ends: Array<{ outcome: string; fields: Record<string, unknown>; content: unknown }> = [];
  const audit = {
    hint: "Fix the audit log.",
    start: async (action: string, fields: Record<string, unknown>, content: unknown) => {
      starts.push({ action, fields, content });
      return starts.length;
    },
    end: (
      _seq: number,
      _action: string,
      outcome: string,
      fields: Record<string, unknown>,
      content: unknown,
    ) => {
      ends.push({ outcome, fields, content });
    },
    host: () => {},
    status: async () => ({ state: "ok" as const, path: "/private/audit.db" }),
  };
  const replies: OutboundEnvelope[] = [];
  const frames: Frame[] = [];
  const executor = createExecutor(
    "This Mac",
    audit,
    (reply) => {
      replies.push(reply);
      return true;
    },
    [],
    (frame) => {
      frames.push(frame);
      return true;
    },
    host,
  );
  cleanup.push(async () => {
    executor.disconnect();
    await executor.idle();
  });
  async function run(action: string, args: unknown = {}, from = owner) {
    const before = replies.length;
    await executor.receive({ id: requestId, from, payload: { type: "request", action, args } });
    return replies[before]?.payload;
  }
  async function bound() {
    return String(result(await run("computer.bind", { windowRef: "opaque-window" })).sessionId);
  }
  return {
    host,
    executor,
    replies,
    frames,
    nativeCalls,
    starts,
    ends,
    run,
    bound,
    dispatch: (fn: typeof dispatch) => {
      dispatch = fn;
    },
  };
}

describe("computer use through the shared executor", () => {
  it("describes configured capabilities without starting the helper or recording content", async () => {
    const f = await fixture();
    expect(result(await f.run("system.info"))).toMatchObject({
      actions: expect.arrayContaining(["computer.bind", "computer.observe"]),
      capabilities: [expect.objectContaining({ prefix: "computer", personal: true })],
    });
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.starts).toHaveLength(0);
  });

  it("records intent metadata before input without storing the written value or AX contents", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    await f.run("computer.observe", { sessionId });
    f.dispatch(async () => {
      expect(f.starts.at(-1)).toMatchObject({
        action: "computer.act",
        fields: { from: owner, args: { operation: "setValue", valueBytes: 13 } },
        content: {},
      });
      return {
        status: "dispatched_unverified",
        effectVerified: false,
        eventsPosted: 0,
        operationsDispatched: 1,
      };
    });
    expect(
      result(
        await f.run("computer.act", {
          sessionId,
          actionId: "unique-action",
          observationId: "opaque-observation",
          stateVersion: 1,
          ref: "opaque-element",
          action: { type: "setValue", value: "PRIVATE VALUE" },
        }),
      ),
    ).toMatchObject({ status: "dispatched_unverified", effectVerified: false });
    expect(JSON.stringify([f.starts, f.ends])).not.toContain("PRIVATE VALUE");
    expect(JSON.stringify([f.starts, f.ends])).not.toContain("PRIVATE AX CONTENT");
    expect(f.ends.every((record) => JSON.stringify(record.content) === "{}")).toBe(true);
  });

  it("returns raw screenshot bytes without logging an image or AX result", async () => {
    const f = await fixture();
    const sessionId = await f.bound();
    await f.executor.receiveFrame({
      type: FRAME_TYPE.request,
      id: requestId,
      peer: owner,
      meta: encodeMeta({
        type: "request",
        action: "computer.observe",
        args: { sessionId, screenshot: true },
      }),
      body: new Uint8Array(),
    });
    const frame = f.frames[0];
    expect(frame.peer).toBe(owner);
    expect([...frame.body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(frame.body.byteLength).toBe(68);
    expect(result(decodeMeta(frame.meta))).toMatchObject({
      screenshot: { mimeType: "image/png", byteLength: 68 },
    });
    expect(f.starts.at(-1)).toMatchObject({
      fields: { transport: "binary", from: owner },
      content: {},
    });
    expect(f.ends.at(-1)?.content).toEqual({});
    expect(JSON.stringify([f.starts, f.ends])).not.toContain("iVBOR");
    expect(JSON.stringify([f.starts, f.ends])).not.toContain("PRIVATE AX CONTENT");
  });
});
