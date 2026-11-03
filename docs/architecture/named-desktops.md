# Named Desktops

A **named desktop** is an X display of its own for one owner, such as the personal WeChat client. It is separate from the shared desktop, `:99`, which the container's s6 services start beside Rome's Chrome. The guardian watches a named desktop at `/desktop/<name>`, the way `/desktop` shows the shared one.

Desktops are static. A fixed table in [`packages/core/src/desktops.ts`](../../packages/core/src/desktops.ts) maps each name to an X display, an RFB port and a websockify port. Adding a desktop means adding a row.

| Name | Display | RFB port | websockify port | Present when |
| --- | --- | --- | --- | --- |
| `wechat` | `:100`, or legacy `WECHAT_USER_DISPLAY` | 5901, or `ROME_WECHAT_VNC_PORT` | 6081, or `ROME_WECHAT_NOVNC_PORT` | WeChat is enabled. A display `wechatUserDisplay` rejects, a port that is not an integer from 1 to 65535, or a display equal to `DISPLAY` fails boot, so WeChat never runs without its row |

## Components

- **The table**: `desktopSlot(name)` returns a desktop's display and ports, or null. It reads configuration only and never looks at processes.
- **The start script**: [`scripts/docker/rome-start-desktop.sh`](../../scripts/docker/rome-start-desktop.sh) `<name> <display> <vnc-port> <novnc-port> [openbox-config]` starts or reuses three processes for one desktop:
  - `Xtigervnc :<n> -localhost yes -rfbport <vnc>`, the X server and its VNC server
  - `openbox` with `DISPLAY=:<n>`, the window manager
  - `websockify 127.0.0.1:<novnc> localhost:<vnc>`, the WebSocket bridge the dashboard's noVNC client connects to

  WeChat's runtime runs it before it starts the client or captures keys, with the arguments `startDesktopArgs` builds from the table row. WeChat's health check also runs it for a client already on the desktop, so a part that died, such as websockify, comes back while the client keeps running. Nothing else starts it: the entrypoint starts only the shared desktop. The runtime gives each run a 20 s `ROME_DESKTOP_LOCK_WAIT` and a timeout above the script's worst case, so a busy lock fails with the script's own message.
- **The desktop proxy**: routes `/desktop-proxy/<name>/` to the table's websockify port.

## Contracts

- `/desktop-proxy` and `/desktop-proxy/websockify` go to the shared desktop. Any other first segment names a desktop. `/desktop-proxy/<name>` and every path under it go to that desktop's websockify port, and answer 404 when the table has no such desktop. `/desktop/<name>` shows no desktop for a name outside `^[a-z][a-z0-9-]{0,31}$` or for `websockify`, because characters such as `?` and `#` would end the proxy path early and reach the shared desktop. Together these mean `/desktop/<name>` never shows the shared desktop under another name.
- The start script is idempotent. It reuses a running X server with the same display and RFB port, an Openbox on that display, and a websockify with the same ports, and it starts only what is missing. It reuses only processes the calling user owns. Runs for the same desktop take turns, under a `flock` on `.rome-desktop-<name>.lock`. Its logs and lock go to `ROME_DESKTOP_LOG_DIR`, by default `~/.cache/rome-desktop` with mode 0700. They are not in `/tmp`, where another account could create the lock first and keep the desktop from starting. For the same reason the script refuses a caller-set directory it does not own, or one that group or others can write. A run waits at most `ROME_DESKTOP_LOCK_WAIT` seconds, 60 by default, for the lock, then fails with a clear error. It exits 1 with the reason on stderr, and 2 on malformed arguments.
- `DesktopPage` encodes the whole socket path into `desktop-vnc.html?path=`, so a name reaches the proxy intact. `NamedDesktopPage`'s name check is defence in depth.

## Invariants

1. **Desktops outlive Rome.** The script starts each program with `setsid`, so it runs in its own session and outlives the script and whoever ran it. A Rome restart leaves the display running, so the WeChat client on it keeps its sign-in. The programs end with the container.
2. **No borrowed displays.** The script refuses a display whose X lock a live X server holds when that server is not the matching Xtigervnc, and a port another process listens on. A lock survives a container restart, when its pid can name any new process, so a lock whose owner is not a live X server running that display counts as stale and is removed. That includes an owner that has exited and an unreaped zombie. A slot never moves: a conflict fails the start.
3. **Loopback only.** The VNC server and websockify listen on loopback only. The only way in from outside is the guardian-gated upgrade on `/desktop-proxy/<name>/`.
4. **Viewing never starts anything.** The proxy only forwards to the table's port. A desktop in the table that is not running answers 502 (connection refused).
