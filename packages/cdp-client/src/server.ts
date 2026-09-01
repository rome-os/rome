import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import CDP from "chrome-remote-interface";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cdpHost = process.env.CDP_HOST || "localhost";
let cdpPort = parseInt(process.env.CDP_PORT || "9222", 10);
const PORT = parseInt(process.env.CDP_CLIENT_PORT || "3200", 10);

const cdpArg = process.argv[2];
if (cdpArg) {
  const lastColon = cdpArg.lastIndexOf(":");
  if (lastColon > 0) {
    cdpHost = cdpArg.substring(0, lastColon);
    cdpPort = parseInt(cdpArg.substring(lastColon + 1), 10);
  } else {
    cdpHost = cdpArg;
  }
}

interface TabInfo {
  id: string;
  title: string;
  url: string;
  type: string;
  faviconUrl?: string;
}

interface PerTabConnection {
  cdp: CDP.Client;
  viewers: Set<WebSocket>;
}

const tabs = new Map<string, TabInfo>();
const tabConnections = new Map<string, PerTabConnection>();
const allClients = new Set<WebSocket>();
let targetWatcherClient: CDP.Client | null = null;
let targetWatcherReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let cdpConnected = false;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    },
  }),
);

app.get("/api/tabs", (_req, res) => {
  res.json(Array.from(tabs.values()));
});

app.get("/api/status", (_req, res) => {
  res.json({ host: cdpHost, port: cdpPort, connected: cdpConnected });
});

app.post("/api/connect", async (req, res) => {
  const { host, port } = req.body;
  if (!host || !port) {
    res.status(400).json({ error: "host and port required" });
    return;
  }
  await reconnectCdp(host, parseInt(String(port), 10));
  res.json({ host: cdpHost, port: cdpPort, connected: cdpConnected });
});

function broadcast(msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of allClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastTabs() {
  broadcast({ type: "tabs:list", tabs: Array.from(tabs.values()) });
}

function broadcastCdpStatus() {
  broadcast({
    type: "cdp:status",
    host: cdpHost,
    port: cdpPort,
    connected: cdpConnected,
  });
}

function isUserPage(url: string): boolean {
  return (
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("devtools://")
  );
}

function safeFaviconUrl(pageUrl: string): string | undefined {
  try {
    const u = new URL(pageUrl);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return `${u.origin}/favicon.ico`;
    }
  } catch {}
  return undefined;
}

async function getBrowserWsUrl(): Promise<string> {
  const res = await fetch(`http://${cdpHost}:${cdpPort}/json/version`);
  const info = await res.json();
  return info.webSocketDebuggerUrl;
}

async function startTargetWatcher() {
  if (targetWatcherReconnectTimer) {
    clearTimeout(targetWatcherReconnectTimer);
    targetWatcherReconnectTimer = null;
  }

  try {
    const browserWsUrl = await getBrowserWsUrl();
    const client = await CDP({ target: browserWsUrl });
    targetWatcherClient = client;
    cdpConnected = true;
    broadcastCdpStatus();
    console.log(`[TargetWatcher] Connected to CDP at ${cdpHost}:${cdpPort}`);

    const { Target } = client;

    Target.targetCreated(({ targetInfo }) => {
      if (targetInfo.type !== "page" || !isUserPage(targetInfo.url)) return;
      tabs.set(targetInfo.targetId, {
        id: targetInfo.targetId,
        title: targetInfo.title || targetInfo.url,
        url: targetInfo.url,
        type: targetInfo.type,
        faviconUrl: safeFaviconUrl(targetInfo.url),
      });
      broadcastTabs();
    });

    Target.targetInfoChanged(({ targetInfo }) => {
      if (targetInfo.type !== "page") return;
      if (!isUserPage(targetInfo.url)) {
        tabs.delete(targetInfo.targetId);
        broadcastTabs();
        return;
      }
      const existing = tabs.get(targetInfo.targetId);
      if (existing) {
        existing.title = targetInfo.title || targetInfo.url;
        existing.url = targetInfo.url;
        existing.faviconUrl = safeFaviconUrl(targetInfo.url);
        broadcastTabs();
        const conn = tabConnections.get(targetInfo.targetId);
        if (conn) {
          const data = JSON.stringify({
            type: "nav:url",
            url: targetInfo.url,
            title: targetInfo.title,
          });
          for (const ws of conn.viewers) {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          }
        }
      }
    });

    Target.targetDestroyed(({ targetId }) => {
      tabs.delete(targetId);
      broadcastTabs();
      const conn = tabConnections.get(targetId);
      if (conn) {
        conn.cdp.close().catch(() => {});
        tabConnections.delete(targetId);
      }
    });

    await Target.setDiscoverTargets({ discover: true });

    client.on("disconnect", () => {
      console.log("[TargetWatcher] Disconnected");
      cdpConnected = false;
      targetWatcherClient = null;
      broadcastCdpStatus();
      scheduleTargetWatcherReconnect();
    });
  } catch (err: any) {
    console.error("[TargetWatcher] Connection failed:", err.message);
    cdpConnected = false;
    broadcastCdpStatus();
    scheduleTargetWatcherReconnect();
  }
}

function scheduleTargetWatcherReconnect() {
  if (targetWatcherReconnectTimer) return;
  targetWatcherReconnectTimer = setTimeout(() => {
    targetWatcherReconnectTimer = null;
    startTargetWatcher();
  }, 3000);
}

async function reconnectCdp(host: string, port: number) {
  // Tear down existing connections
  if (targetWatcherReconnectTimer) {
    clearTimeout(targetWatcherReconnectTimer);
    targetWatcherReconnectTimer = null;
  }
  if (targetWatcherClient) {
    try {
      await targetWatcherClient.close();
    } catch {}
    targetWatcherClient = null;
  }
  for (const [id, conn] of tabConnections) {
    try {
      await conn.cdp.close();
    } catch {}
    tabConnections.delete(id);
  }
  tabs.clear();
  cdpConnected = false;

  cdpHost = host;
  cdpPort = port;
  broadcastCdpStatus();
  broadcastTabs();
  await startTargetWatcher();
}

async function getOrCreateTabConnection(targetId: string): Promise<PerTabConnection | null> {
  const existing = tabConnections.get(targetId);
  if (existing) {
    // Re-activate the target for headless Chrome
    if (targetWatcherClient) {
      await targetWatcherClient.Target.activateTarget({ targetId });
    }
    return existing;
  }

  try {
    // Activate the target first — headless Chrome only renders the active tab
    if (targetWatcherClient) {
      await targetWatcherClient.Target.activateTarget({ targetId });
    }

    const client = await CDP({ host: cdpHost, port: cdpPort, target: targetId });
    const conn: PerTabConnection = { cdp: client, viewers: new Set() };

    const { Page } = client;
    await Page.enable();

    Page.screencastFrame(async ({ data, metadata, sessionId }) => {
      const msg = JSON.stringify({
        type: "screencast:frame",
        data,
        metadata,
        sessionId,
      });
      for (const ws of conn.viewers) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
      try {
        await Page.screencastFrameAck({ sessionId });
      } catch {}
    });

    Page.frameNavigated(({ frame }) => {
      if (!frame.parentId) {
        const msg = JSON.stringify({ type: "nav:url", url: frame.url });
        for (const ws of conn.viewers) {
          if (ws.readyState === WebSocket.OPEN) ws.send(msg);
        }
      }
    });

    await Page.startScreencast({
      format: "jpeg",
      quality: 60,
      maxWidth: 1920,
      maxHeight: 1080,
    });

    client.on("disconnect", () => {
      tabConnections.delete(targetId);
    });

    tabConnections.set(targetId, conn);
    return conn;
  } catch (err: any) {
    console.error(`[Tab] Failed to connect to ${targetId}:`, err.message);
    return null;
  }
}

function removeViewerFromTab(ws: WebSocket, targetId: string) {
  const conn = tabConnections.get(targetId);
  if (!conn) return;
  conn.viewers.delete(ws);
  if (conn.viewers.size === 0) {
    conn.cdp.Page.stopScreencast().catch(() => {});
    conn.cdp.close().catch(() => {});
    tabConnections.delete(targetId);
  }
}

wss.on("connection", (ws) => {
  allClients.add(ws);
  let currentTabId: string | null = null;

  ws.send(
    JSON.stringify({
      type: "cdp:status",
      host: cdpHost,
      port: cdpPort,
      connected: cdpConnected,
    }),
  );
  ws.send(JSON.stringify({ type: "tabs:list", tabs: Array.from(tabs.values()) }));

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "tab:switch": {
          if (currentTabId) {
            removeViewerFromTab(ws, currentTabId);
          }
          currentTabId = msg.targetId;
          if (currentTabId) {
            const conn = await getOrCreateTabConnection(currentTabId);
            if (conn) {
              conn.viewers.add(ws);
              // Re-trigger screencast to make sure this viewer gets a frame
              // (first frame may have fired before viewer was added)
              await conn.cdp.Page.startScreencast({
                format: "jpeg",
                quality: 60,
                maxWidth: 1920,
                maxHeight: 1080,
              });
            } else {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Failed to connect to tab",
                }),
              );
              currentTabId = null;
            }
          }
          break;
        }
        case "tab:new": {
          try {
            await CDP.New({
              host: cdpHost,
              port: cdpPort,
              url: msg.url || "about:blank",
            });
          } catch (err: any) {
            console.error("[Tab] Failed to create new tab:", err.message);
          }
          break;
        }
        case "tab:close": {
          try {
            await CDP.Close({
              host: cdpHost,
              port: cdpPort,
              id: msg.targetId,
            });
          } catch (err: any) {
            console.error("[Tab] Failed to close tab:", err.message);
          }
          break;
        }

        case "cdp:connect": {
          if (msg.host && msg.port) {
            await reconnectCdp(msg.host, parseInt(String(msg.port), 10));
          }
          break;
        }

        case "nav:go": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) await conn.cdp.Page.navigate({ url: msg.url });
          break;
        }
        case "nav:back": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) {
            try {
              const { currentIndex, entries } = await conn.cdp.Page.getNavigationHistory();
              if (currentIndex > 0) {
                await conn.cdp.Page.navigateToHistoryEntry({
                  entryId: entries[currentIndex - 1].id,
                });
              }
            } catch {}
          }
          break;
        }
        case "nav:forward": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) {
            try {
              const { currentIndex, entries } = await conn.cdp.Page.getNavigationHistory();
              if (currentIndex < entries.length - 1) {
                await conn.cdp.Page.navigateToHistoryEntry({
                  entryId: entries[currentIndex + 1].id,
                });
              }
            } catch {}
          }
          break;
        }
        case "nav:reload": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) {
            try {
              await conn.cdp.Page.reload();
            } catch {}
          }
          break;
        }

        case "input:mouse": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) {
            await conn.cdp.Input.dispatchMouseEvent(msg.params);
          }
          break;
        }
        case "input:key": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) {
            await conn.cdp.Input.dispatchKeyEvent(msg.params);
          }
          break;
        }
        case "input:paste": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) {
            await conn.cdp.Input.insertText({ text: msg.text });
          }
          break;
        }
        case "input:copy": {
          const conn = currentTabId ? tabConnections.get(currentTabId) : null;
          if (conn) {
            const result = await conn.cdp.Runtime.evaluate({
              expression: "window.getSelection().toString()",
            });
            ws.send(
              JSON.stringify({
                type: "copy:result",
                text: result.result.value || "",
              }),
            );
          }
          break;
        }
      }
    } catch (err: any) {
      console.error("[WS] Command error:", err.message);
    }
  });

  ws.on("close", () => {
    allClients.delete(ws);
    if (currentTabId) {
      removeViewerFromTab(ws, currentTabId);
    }
  });

  ws.on("error", () => {
    allClients.delete(ws);
    if (currentTabId) {
      removeViewerFromTab(ws, currentTabId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`CDP Client running on http://localhost:${PORT}`);
  console.log(`Targeting Chrome CDP at ${cdpHost}:${cdpPort}`);
  startTargetWatcher();
});
