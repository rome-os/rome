import { Hono } from "hono";

export function desktopProxyRoutes(): Hono {
  const app = new Hono();
  app.all("/desktop-proxy", (c) => c.text("Not Found", 404));
  app.all("/desktop-proxy/*", (c) => c.text("Not Found", 404));
  return app;
}
