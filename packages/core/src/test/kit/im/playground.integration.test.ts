import { describe, expect, it } from "@rstest/core";
import { startPlayground, playgroundPresets } from "./playground.js";

async function idle(url: string) {
  let state!: {
    busy: boolean;
    error: string;
    errors: string[];
    messages: { text: string; direction: string }[];
    receipts: { outcome: string }[];
  };
  await expect
    .poll(
      async () => {
        state = await (await fetch(`${url}/state`)).json();
        return state.busy;
      },
      { timeout: 15000 },
    )
    .toBe(false);
  return state;
}

describe.each([
  "discord",
  "telegram",
  "feishu",
  "wechat",
] as const)("playground: %s", (platform) => {
  it("routes the same inbound and output through conversation delivery and records receipts", async () => {
    const app = await startPlayground();
    const post = (path: string, body: unknown) =>
      fetch(`${app.url}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      expect(
        (
          await post("config", {
            ...playgroundPresets[platform],
            chunkSize: 7,
            step: 3,
            intervalMs: 10,
          })
        ).status,
      ).toBe(200);
      expect((await post("run", { action: "inbound", text: "question" })).status).toBe(202);
      expect((await idle(app.url)).messages).toEqual([
        expect.objectContaining({ text: "question", direction: "in" }),
      ]);
      expect((await post("run", { action: "stream", text: "preview final now!" })).status).toBe(
        202,
      );
      const state = await idle(app.url);
      expect(state.error).toBe("");
      expect(
        state.messages
          .filter((message: { direction: string }) => message.direction === "out")
          .map((message: { text: string }) => message.text)
          .join(""),
      ).toBe("preview final now!");
      expect(state.receipts.length).toBeGreaterThanOrEqual(3);
      expect(
        state.receipts.every((receipt: { outcome: string }) => receipt.outcome === "accepted"),
      ).toBe(true);
      expect(state.errors).toEqual([]);
      await post("run", { action: "stream", text: "denied", fault: "reject" });
      const rejected = await idle(app.url);
      expect(rejected.error).not.toBe("");
      expect(rejected.messages).toEqual(state.messages);
    } finally {
      await app.close();
    }
  }, 25000);
});

it("rejects foreign origins and invalid configuration without exposing exception details", async () => {
  const app = await startPlayground();
  try {
    expect(
      (await fetch(`${app.url}/state`, { headers: { origin: "https://example.invalid" } })).status,
    ).toBe(403);
    const response = await fetch(`${app.url}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid playground configuration or command" });
  } finally {
    await app.close();
  }
});

it("stops generation, refuses a reset while active, and preserves an ambiguous accepted message", async () => {
  const app = await startPlayground();
  const post = (path: string, body: unknown) =>
    fetch(`${app.url}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await post("run", { action: "stream", text: "hello".repeat(100) });
    expect((await post("config", playgroundPresets.discord)).status).toBe(409);
    expect((await post("stop", {})).status).toBe(200);
    await idle(app.url);
    await post("config", playgroundPresets.telegram);
    await post("run", { action: "stream", text: "accepted", fault: "drop" });
    const state = await idle(app.url);
    expect(state.error).not.toBe("");
    expect(state.messages).toEqual([expect.objectContaining({ text: "accepted" })]);
    expect(state.receipts).toContainEqual(expect.objectContaining({ outcome: "unknown" }));
  } finally {
    await app.close();
  }
});
