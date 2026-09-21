import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { createLogger } from "./logger.js";
import { ClaudeLoginCodeValidationError, formatClaudeLoginCodeInput } from "./claude-login-code.js";
import { createClaudeLoginWatcher } from "./claude-login-watch.js";

const log = createLogger("terminal-server");

interface TerminalCommandPreset {
  cmd: string;
  args: string[];
}

/** Whitelist of allowed command presets. Adding a new tool = one entry here. */
export const TERMINAL_COMMAND_PRESETS: Record<string, TerminalCommandPreset> = {
  // `claude /login` enters the subscription OAuth flow and reads the pasted code
  // from stdin. The login watcher accepts the first-run theme/login defaults,
  // then surfaces the OAuth URL to the native UI.
  "claude-login": { cmd: "claude", args: ["/login"] },
  // Pi setup stays in the guardian's own terminal: Pi's interactive CLI exposes
  // a `!`/`!!` shell escape, and this websocket is proxied without forward_auth
  // (see caddyfile-generator `@wsUpgrade`), so spawning it here would be an
  // unauthenticated RCE surface. Rome only observes Pi's usable models via
  // discovery/refresh and never runs the Pi CLI itself. See pi-llm-provider spec D3.
  // Logout (Claude and Codex) is non-interactive and runs via an HTTP endpoint
  // (ai-tools.ts: `claude auth logout` / the app-server `account/logout` RPC),
  // not a PTY.
};

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

interface TerminalSession {
  ptyProcess: pty.IPty;
  ws: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  pingTimer: ReturnType<typeof setTimeout> | null;
  disposeLoginWatcher?: () => void;
}

const sessions = new Set<TerminalSession>();

function cleanup(session: TerminalSession) {
  sessions.delete(session);
  clearTimeout(session.timer);
  if (session.pingTimer !== null) {
    clearTimeout(session.pingTimer);
    session.pingTimer = null;
  }
  session.disposeLoginWatcher?.();
  session.disposeLoginWatcher = undefined;
  try {
    session.ptyProcess.kill();
  } catch {
    /* already dead */
  }
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.close();
  }
}

export interface TerminalServerOptions {
  /**
   * Called when a login/logout terminal command exits. Every preset here is an
   * auth flow (claude/codex login/logout), so the caller refreshes cached
   * login state. Fires regardless of success — the exit is just a hint to
   * re-probe; it carries no trustworthy "logged in" signal of its own.
   */
  onAuthCommandExit?: (preset: string) => void;
}

export function attachTerminalServer(
  httpServer: Server,
  options: TerminalServerOptions = {},
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/terminal") {
      // Not for us — let other upgrade handlers (if any) deal with it,
      // or just destroy if nothing else is listening.
      return;
    }

    const preset = url.searchParams.get("preset");
    if (!preset || !TERMINAL_COMMAND_PRESETS[preset]) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, preset);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, preset: string) => {
    const command = TERMINAL_COMMAND_PRESETS[preset];
    log.info("terminal session started", { preset, cmd: command.cmd });

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(command.cmd, command.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      log.error("failed to spawn PTY", {
        preset,
        error: err instanceof Error ? err.message : String(err),
      });
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Failed to spawn command: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      ws.close();
      return;
    }

    const session: TerminalSession = {
      ptyProcess,
      ws,
      timer: setTimeout(() => {
        log.info("terminal session timed out", { preset });
        ws.send(JSON.stringify({ type: "error", message: "Session timed out (5 min limit)" }));
        cleanup(session);
      }, SESSION_TIMEOUT_MS),
      pingTimer: null,
    };
    sessions.add(session);

    // Keepalive pings: start at 1 s, double each time, cap at 20 s.
    // Prevents reverse-proxies (e.g. Caddy) from closing idle WebSocket
    // connections while the user is completing an OAuth flow in the browser.
    const PING_INITIAL_MS = 1_000;
    const PING_MAX_MS = 20_000;
    let pingDelayMs = PING_INITIAL_MS;
    function schedulePing() {
      session.pingTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          pingDelayMs = Math.min(pingDelayMs * 2, PING_MAX_MS);
          schedulePing();
        }
      }, pingDelayMs);
    }
    schedulePing();

    // Watch the login output to drive the flow natively: the watcher auto-selects
    // the first-run wizard's theme and Claude AI login by writing Enter back to
    // the PTY, and forwards the sign-in URL and code-rejected errors to the
    // client. Scoped to `claude-login`: it writes Enter back on matching prompts,
    // so it must never run against another tool's TUI (which could render text it
    // false-matches). The raw `output` stream is always sent too, so a parser
    // miss degrades to the terminal escape hatch rather than a stuck UI.
    const loginWatcher =
      preset === "claude-login"
        ? createClaudeLoginWatcher(
            (event) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(event));
              }
            },
            (data) => ptyProcess.write(data),
          )
        : null;
    session.disposeLoginWatcher = () => loginWatcher?.dispose();

    // PTY → WebSocket
    ptyProcess.onData((data: string) => {
      loginWatcher?.push(data);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      log.info("terminal process exited", { preset, exitCode });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      }
      // All presets are auth flows; the exit is our cue to re-probe login state.
      try {
        options.onAuthCommandExit?.(preset);
      } catch (err) {
        log.warn("onAuthCommandExit hook threw", {
          preset,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      cleanup(session);
    });

    // WebSocket → PTY
    ws.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (msg.type === "input" && typeof msg.data === "string") {
          ptyProcess.write(msg.data);
        } else if (msg.type === "submit_code" && typeof msg.code === "string") {
          // Native code box → the CLI's "Paste code here" prompt. Trim stray
          // whitespace the user may have copied around the code, extract the
          // `code=` value if the browser copied a callback URL, then send the
          // sanitized code plus Enter to the PTY.
          try {
            ptyProcess.write(formatClaudeLoginCodeInput(msg.code));
          } catch (err) {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(
              JSON.stringify({
                type: "auth_error",
                message:
                  err instanceof ClaudeLoginCodeValidationError
                    ? err.message
                    : "Could not read the Claude sign-in code.",
              }),
            );
          }
        } else if (
          msg.type === "resize" &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          ptyProcess.resize(msg.cols, msg.rows);
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    ws.on("close", () => {
      log.info("terminal WebSocket closed", { preset });
      cleanup(session);
    });

    ws.on("error", (err) => {
      log.error("terminal WebSocket error", { error: err.message });
      cleanup(session);
    });
  });

  return {
    close() {
      for (const session of sessions) {
        cleanup(session);
      }
      wss.close();
    },
  };
}
