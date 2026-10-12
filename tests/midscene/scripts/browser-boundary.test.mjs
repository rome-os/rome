import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { checkBrowserBoundary } = await tsImport("../browser-boundary.ts", import.meta.url);

for (const event of ["onerror", "onclose"]) {
  test(`transpiled WebSocket probe handles ${event} without Node-side helpers`, async () => {
    let contexts = 0;
    let evaluated = false;
    const browser = {
      async newContext() {
        const index = contexts++;
        return {
          async close() {},
          async route() {},
          async routeWebSocket() {},
          async newPage() {
            return {
              async goto() {},
              async reload() {},
              async waitForFunction() {},
              async evaluate(callback, argument) {
                if (index === 0 && argument === undefined) {
                  return {
                    session: { status: 503, body: { error: "/api/chat/sessions mock mode" } },
                    login: { status: 401, body: { error: "Login failed" } },
                    unhandled: { status: 503, body: { error: "POST /api/not-mocked" } },
                  };
                }
                if (index !== 2) return;
                evaluated = true;
                // Playwright serializes callbacks into a browser with no tsx helpers.
                return vm.runInNewContext(`(${callback.toString()})(${JSON.stringify(argument)})`, {
                  WebSocket: class {
                    constructor() {
                      queueMicrotask(() => this[event]?.());
                    }
                    close() {}
                  },
                  setTimeout,
                  clearTimeout,
                });
              },
            };
          },
        };
      },
    };
    await checkBrowserBoundary(browser, "http://localhost:3200");
    assert.equal(evaluated, true);
  });
}
