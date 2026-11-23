import { describe, expect, it } from "@rstest/core";
import { isSlackFrame, SLACK_DEPOSIT_HEADER } from "./deposit.js";
import type { CapabilityStatus } from "../../types.js";
import { deliverSlackFrame, SlackSetupHolds } from "./drain.js";

const frame = { headers: { [SLACK_DEPOSIT_HEADER]: "1" }, body: new Uint8Array([123, 125]) };

const RUNNING = { state: "unlocked" } as const;

/** Each connection's answer to a frame, and its chat status (running unless named). */
function registry(
  answers: Record<string, unknown | Error>,
  chat: Record<string, CapabilityStatus> = {},
) {
  const asked: string[] = [];
  return {
    asked,
    find: () =>
      Object.keys(answers).map((id) => ({
        id,
        status: () => ({ chat: chat[id] ?? RUNNING }),
      })) as never,
    ingest: async (id: string) => {
      asked.push(id);
      const answer = answers[id];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("Slack frames in the instance's mailbox", () => {
  it("picks out what the Slack gateway Worker deposited, whatever the header's case", () => {
    expect(isSlackFrame({ "X-Rome-Slack": "1" })).toBe(true);
    expect(isSlackFrame({ "x-rome-discord": "1" })).toBe(false);
  });

  it("hands a frame to the connection that holds its workspace", async () => {
    const r = registry({ c1: { status: 400 }, c2: { status: 200 } });
    expect(await deliverSlackFrame(r, frame)).toEqual({ status: 200 });
    expect(r.asked).toEqual(["c1", "c2"]);
  });

  it("passes on a connection's refusal for it to be delivered again", async () => {
    expect(await deliverSlackFrame(registry({ c1: { status: 500 } }), frame)).toEqual({
      status: 500,
    });
  });

  it("drops a frame no connection takes", async () => {
    expect(await deliverSlackFrame(registry({}), frame)).toEqual({ status: 200 });
    expect(await deliverSlackFrame(registry({ c1: { status: 400 } }), frame)).toEqual({
      status: 200,
    });
  });

  it("has a frame delivered again while its connection is starting", async () => {
    expect(
      await deliverSlackFrame(registry({ c1: new Error("Ingress is unavailable") }), frame),
    ).toEqual({ status: 503 });
  });

  it("drops a frame, rather than holding the mailbox, while its connection will not start alone", async () => {
    const noIngress = new Error("Ingress is unavailable");
    for (const chat of [
      // Waiting for the guardian.
      { state: "unlocked", degradation: { reason: "approve again" } },
      // Broken or locked: the grant is not authorized, as with a grant from
      // before the Worker.
      { state: "needs-auth", missingGrants: ["bot"] },
    ] as CapabilityStatus[]) {
      expect(await deliverSlackFrame(registry({ c1: noIngress }, { c1: chat }), frame)).toEqual({
        status: 200,
      });
    }
  });

  it("still hands a frame to a running connection beside one that is not running", async () => {
    const r = registry(
      { c1: new Error("Ingress is unavailable"), c2: { status: 200 } },
      { c1: { state: "needs-auth", missingGrants: ["bot"] } },
    );
    expect(await deliverSlackFrame(r, frame)).toEqual({ status: 200 });
    expect(r.asked).toEqual(["c1", "c2"]);
  });

  it("waits for a starting connection before dropping a frame no running one takes", async () => {
    const r = registry({ c1: { status: 400 }, c2: new Error("Ingress is unavailable") });
    expect(await deliverSlackFrame(r, frame)).toEqual({ status: 503 });
  });

  it("holds a frame no connection takes while a setup waits for approval", async () => {
    const holds = new SlackSetupHolds();
    const released: string[] = [];
    const release = holds.hold(() => released.push("resumed"));
    expect(await deliverSlackFrame(registry({}), frame, holds)).toEqual({ status: 503 });
    expect(
      await deliverSlackFrame(
        registry(
          { c1: new Error("Ingress is unavailable") },
          { c1: { state: "needs-auth", missingGrants: ["bot"] } },
        ),
        frame,
        holds,
      ),
    ).toEqual({ status: 503 });
    release();
    release();
    expect(released).toEqual(["resumed"]);
    expect(holds.any).toBe(false);
    expect(await deliverSlackFrame(registry({}), frame, holds)).toEqual({ status: 200 });
  });
});
