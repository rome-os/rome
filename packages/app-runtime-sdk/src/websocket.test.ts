import { describe, it, expect, rs } from "@rstest/core";
import {
  upgradeWebSocket,
  type RomeAppApiRequest,
  type RomeAppWebSocketHandlers,
} from "./index.js";

const WS_UPGRADE_ACCEPT = Symbol.for("rome-os.app-runtime.ws.accept");

function makeRequest(extra: Record<string | symbol, unknown> = {}): RomeAppApiRequest {
  return {
    method: "GET",
    path: ["live"],
    headers: {},
    query: new URLSearchParams(),
    ...extra,
  } as RomeAppApiRequest;
}

describe("upgradeWebSocket", () => {
  it("returns 426 when the request carries no host upgrade bridge", () => {
    const res = upgradeWebSocket(makeRequest(), {});
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("websocket");
  });

  it("delegates to the host-injected accept bridge and returns its response", () => {
    const sentinel = new Response(null, { status: 200 });
    const accept = rs.fn((_h: RomeAppWebSocketHandlers) => sentinel);
    const handlers: RomeAppWebSocketHandlers = { message() {} };

    const res = upgradeWebSocket(makeRequest({ [WS_UPGRADE_ACCEPT]: accept }), handlers);

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(handlers);
    expect(res).toBe(sentinel);
  });

  it("ignores a non-function value under the bridge symbol", () => {
    const res = upgradeWebSocket(makeRequest({ [WS_UPGRADE_ACCEPT]: "nope" }), {});
    expect(res.status).toBe(426);
  });
});
