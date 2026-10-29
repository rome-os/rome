import type { ConnectOrigin } from "./csrf.js";

/**
 * The OAuth authorize tab is always opened with `window.open`, so where it lands
 * after Composio redirects back depends on who started the connect:
 *
 * - `dashboard` — redirect to Settings › Connections with the result in the
 *   query string; Settings surfaces the "<app> connected" notice.
 * - `webchat` — an inline card in the chat transcript started the flow and is
 *   already polling for the connection, so the tab has no dashboard to return
 *   to. Land it on a terminal confirmation that nudges the guardian back to
 *   their chat (and self-closes), instead of pulling them into settings.
 */
export function buildCallbackResponse(
  origin: ConnectOrigin,
  provider: string,
  ok: boolean,
): Response {
  if (origin === "webchat") {
    return connectedTabResponse(ok);
  }
  const status = ok ? "ACTIVE" : "failed";
  const settingsUrl = `/settings/connections?connector=${encodeURIComponent(provider)}&status=${encodeURIComponent(status)}`;
  return new Response(null, { status: 302, headers: { location: settingsUrl } });
}

function connectedTabResponse(ok: boolean): Response {
  const title = ok ? "Connected" : "Couldn't connect";
  const detail = ok
    ? "You can close this tab and return to your chat."
    : "Return to your chat and try again.";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: system-ui, -apple-system, sans-serif; background: Canvas; color: CanvasText; }
  .card { max-width: 22rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { font-size: 0.875rem; opacity: 0.7; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${detail}</p>
  </div>
  <script>setTimeout(function () { try { window.close(); } catch (e) {} }, 800);</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
