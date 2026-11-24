import { readFileSync } from "node:fs";
import { describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createAction as connectService } from "./connect-service/index.js";
import { createAction as disconnectService } from "./disconnect-service/index.js";
import { createAction as readConnections } from "./read-connections/index.js";

const config = (name: string) =>
  ({ name, type: "system", description: "", sideEffects: "write" }) as unknown as ActionConfig;

const manifest = (dir: string) =>
  readFileSync(new URL(`./${dir}/action.yaml`, import.meta.url), "utf8");

describe("the connection actions core runs", () => {
  it("read_connections hands its input to core's read", async () => {
    const call = rs.fn(async () => ({ status: "ok" as const, data: { connections: [] } }));

    const result = await readConnections(config("read_connections"), {
      connectionControl: { call },
    }).execute({});

    expect(call).toHaveBeenCalledWith("read", {});
    expect(result).toEqual({ status: "ok", data: { connections: [] } });
  });

  it("connect_service hands the kind to core's connect, and returns the card core gives", async () => {
    const card = {
      status: "pending_interaction" as const,
      interaction: {
        appId: "core",
        promptText: "Connect GitHub to Rome, from Settings › Connections.",
        render: { kind: "inline" as const, componentId: "connect-card", props: { kind: "github" } },
      },
    };
    const call = rs.fn(async () => card);

    const result = await connectService(config("connect_service"), {
      connectionControl: { call },
    }).execute({ kind: "github" });

    expect(call).toHaveBeenCalledWith("connect", { kind: "github" });
    expect(result).toEqual(card);
  });

  it("disconnect_service hands the connection's id to core's disconnect", async () => {
    const call = rs.fn(async () => ({ status: "ok" as const, data: { disconnected: true } }));

    const result = await disconnectService(config("disconnect_service"), {
      connectionControl: { call },
    }).execute({ connectionId: "c-1" });

    expect(call).toHaveBeenCalledWith("disconnect", { connectionId: "c-1" });
    expect(result).toEqual({ status: "ok", data: { disconnected: true } });
  });

  it("disconnect_service waits for the guardian's approval", () => {
    expect(manifest("disconnect-service")).toMatch(/^requiresApproval: true$/m);
    expect(manifest("read-connections")).not.toMatch(/requiresApproval: true/);
  });

  it("disconnect_service's approval card is worded by core from the connection it names", async () => {
    const preview = { kind: "generic", title: "Disconnect Slack (Acme)", summary: "…" };
    const call = rs.fn(async () => ({ status: "ok" as const, data: preview }));
    const action = disconnectService(config("disconnect_service"), {
      connectionControl: { call },
    });

    expect(await action.preview?.({ connectionId: "c-1" })).toEqual(preview);
    expect(call).toHaveBeenCalledWith("previewDisconnect", { connectionId: "c-1" });
  });

  it("disconnect_service's approval card says why when core finds no connection", async () => {
    const call = rs.fn(async () => ({ status: "error" as const, error: "No connection found" }));
    const action = disconnectService(config("disconnect_service"), {
      connectionControl: { call },
    });

    expect(await action.preview?.({ connectionId: "nope" })).toEqual({
      kind: "generic",
      title: "Disconnect a connection",
      summary: "No connection found",
    });
  });

  for (const [name, factory] of [
    ["read_connections", readConnections],
    ["connect_service", connectService],
    ["disconnect_service", disconnectService],
  ] as const) {
    it(`${name} fails to load without core's connection operations`, () => {
      expect(() => factory(config(name), {} as never)).toThrow(
        `${name} requires a connectionControl dep`,
      );
    });
  }
});
