import { afterEach, describe, expect, it } from "@rstest/core";
import { startPiPrototypeUiServer } from "./ui-server.js";

const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeServers.splice(0).map((close) => close()));
});

describe("Pi provider UI prototype", () => {
  it("serves a visibly labeled prototype with a deterministic UI turn", async () => {
    const server = await startPiPrototypeUiServer(0);
    closeServers.push(server.close);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("PROTOTYPE · LOCAL ONLY");

    const discoveryResponse = await fetch(`${server.url}/api/models?mode=demo`);
    const discovery = (await discoveryResponse.json()) as {
      models: Array<{ qualifiedModelId: string }>;
    };
    expect(discoveryResponse.status).toBe(200);
    expect(discovery.models.map((model) => model.qualifiedModelId)).toEqual([
      "prototype-anthropic/shared%2Fmodel",
      "prototype-openai/shared%2Fmodel",
    ]);

    const turnResponse = await fetch(`${server.url}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "demo",
        qualifiedModelId: discovery.models[0].qualifiedModelId,
        prompt: "Hello from the browser",
      }),
    });
    const events = (await turnResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(turnResponse.status).toBe(200);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      accounting: {
        provider: "pi",
        model: "prototype-anthropic/shared%2Fmodel",
      },
    });
  });
});
