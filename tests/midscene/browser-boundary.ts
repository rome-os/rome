import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { installBrowserNetworkGuard } from "./browser-network-guard.js";

export async function checkBrowserBoundary(browser: Browser, baseUrl: string) {
  let externalRequests = 0;
  let externalSockets = 0;
  const external = createServer((_request, response) => {
    externalRequests += 1;
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    response.end("unexpected external request");
  });
  external.on("upgrade", (_request, socket) => {
    externalSockets += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const port = (external.address() as AddressInfo).port;
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        async () => (await navigator.serviceWorker.getRegistration())?.active,
      );
      // The first navigation can register an active worker without giving it
      // control of that document. Reload so this request tests the MSW path.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      // A controlling worker passes requests through until the page's MSW
      // client activates it. The mock entry renders the app only after
      // worker.start() resolves, so the sidebar marks MSW as ready.
      await page.locator('a[href="/chat"]').first().waitFor({ timeout: 60_000 });
      const mockedApi = await page.evaluate(async () => {
        const session = await fetch("/api/chat/sessions", { method: "POST" });
        const login = await fetch("/api/auth/login", { method: "POST" });
        const unhandled = await fetch("/api/not-mocked", { method: "POST" });
        return {
          session: { status: session.status, body: await session.json() },
          login: { status: login.status, body: await login.json() },
          unhandled: { status: unhandled.status, body: await unhandled.json() },
        };
      });
      assert.equal(mockedApi.session.status, 503);
      assert.match(mockedApi.session.body.error, /\/api\/chat\/sessions.*mock mode/);
      assert.equal(mockedApi.login.status, 401);
      assert.equal(mockedApi.login.body.error, "Login failed");
      assert.equal(mockedApi.unhandled.status, 503);
      assert.match(mockedApi.unhandled.body.error, /POST \/api\/not-mocked/);
      await page.evaluate(async (url) => {
        try {
          await fetch(url, { mode: "no-cors" });
        } catch {}
      }, `http://127.0.0.1:${port}/foreign`);
      assert.equal(externalRequests, 0, "MSW allowed an external HTTP request");
    } finally {
      await context.close();
    }

    const httpContext = await browser.newContext({ serviceWorkers: "block" });
    try {
      await installBrowserNetworkGuard(httpContext, baseUrl);
      const page = await httpContext.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(async (url) => {
        try {
          await fetch(url, { mode: "no-cors" });
        } catch {}
      }, `http://127.0.0.1:${port}/foreign`);
      assert.equal(externalRequests, 0, "the browser guard allowed an external HTTP request");
    } finally {
      await httpContext.close();
    }

    const socketContext = await browser.newContext();
    try {
      await installBrowserNetworkGuard(socketContext, baseUrl);
      const page = await socketContext.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(async (url) => {
        await new Promise((resolve) => {
          const socket = new WebSocket(url);
          const timer = setTimeout(() => {
            socket.close();
            resolve(null);
          }, 10_000);
          // Named local callbacks acquire tsx helpers unavailable in the browser.
          socket.onerror = () => {
            clearTimeout(timer);
            resolve(null);
          };
          socket.onclose = () => {
            clearTimeout(timer);
            resolve(null);
          };
        });
      }, `ws://127.0.0.1:${port}/foreign`);
      assert.equal(externalSockets, 0, "the browser guard allowed an external WebSocket");
    } finally {
      await socketContext.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      external.close((error) => (error ? reject(error) : resolve())),
    );
  }

  console.log(
    "Browser boundary OK: mock API, MSW HTTP, browser HTTP, and WebSocket traffic was blocked.",
  );
}
