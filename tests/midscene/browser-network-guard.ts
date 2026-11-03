import type { BrowserContext } from "playwright";

export async function installBrowserNetworkGuard(context: BrowserContext, baseUrl: string) {
  const base = new URL(baseUrl);
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === base.origin) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (route) => {
    const url = new URL(route.url());
    const protocol = base.protocol === "https:" ? "wss:" : "ws:";
    if (url.protocol === protocol && url.host === base.host) {
      route.connectToServer();
      return;
    }
    void route.close({ code: 1008, reason: "External WebSocket blocked" });
  });
}
