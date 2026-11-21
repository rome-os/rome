import { describe, expect, it } from "@rstest/core";
import { isSlackFrame, SLACK_DEPOSIT_HEADER } from "./deposit.js";
import { deliverSlackFrame } from "./drain.js";

const frame = { headers: { [SLACK_DEPOSIT_HEADER]: "1" }, body: new Uint8Array([123, 125]) };

function registry(answers: Record<string, unknown | Error>) {
  const asked: string[] = [];
  return {
    asked,
    find: () => Object.keys(answers).map((id) => ({ id })) as never,
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

  it("has a frame delivered again while its connection has not started", async () => {
    expect(
      await deliverSlackFrame(registry({ c1: new Error("Ingress is unavailable") }), frame),
    ).toEqual({ status: 503 });
  });
});
