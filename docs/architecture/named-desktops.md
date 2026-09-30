# Named Desktops

A **named desktop** is an X display that Rome core starts at runtime for one owner, such as the personal WeChat client. It is separate from the shared desktop, `:99`, which the container entrypoint starts beside Rome's Chrome. The guardian watches a named desktop at `/desktop/<name>`, the way `/desktop` shows the shared one.

`DesktopManager` in [`packages/core/src/desktops/`](../../packages/core/src/desktops/) owns named desktops.

## Components

Each named desktop is three processes, all started by Rome as its own user:

| Process | Role |
| --- | --- |
| `Xtigervnc :<n> -localhost yes -rfbport <vnc>` | The X server and its VNC server |
| `openbox` with `DISPLAY=:<n>` | The window manager |
| `websockify 127.0.0.1:<novnc> localhost:<vnc>` | The WebSocket bridge the dashboard's noVNC client connects to |

Each process carries `ROME_DESKTOP=<name>` in its environment. Rome finds its desktops by that marker in `/proc`, so no state file records them.

## Contracts

- `acquire(name)` returns a running desktop. It adopts whatever part already runs and starts only what is missing. It is idempotent, so an owner may call it on every health check to heal a crashed display.
- `get(name)` returns the running desktop or null. It never starts anything. The desktop proxy uses it, so opening `/desktop/<name>` cannot create a display.
- `/desktop-proxy` and `/desktop-proxy/websockify` go to the shared desktop. Any other first segment names a desktop: `/desktop-proxy/<name>` and every path under it go to that desktop's websockify. They answer 404 when the segment is not a valid name or the desktop is not running, so `/desktop/<name>` never shows the shared desktop under another name.
- A name matches `^[a-z][a-z0-9-]{0,31}$`. The name `websockify` is reserved, because `/desktop-proxy/websockify` is the shared desktop's socket path.

## Invariants

1. **One desktop per name.** `acquire` looks for a running desktop before it chooses a slot, and it serialises its calls.
2. **Slots.** Slot `k` is display `:100+k`, RFB port `5901+k` and websockify port `6081+k`, for `k` from 0 to 63. A name takes the first free slot. A slot is free when no X server runs on its display, no live process owns its X lock, and neither port is listening. A zombie does not count as live. When a name's X server has died but its websockify still runs, the name returns to that slot and adopts the websockify.
3. **Pins.** A pinned name always uses its pin. Legacy `WECHAT_USER_DISPLAY` pins `wechat`, with `ROME_WECHAT_VNC_PORT` and `ROME_WECHAT_NOVNC_PORT`. A pinned name adopts a matching X server that has no marker, which is how Rome takes over the display the entrypoint started for WeChat. When something else holds the pin, `acquire` fails rather than move. No other name takes a slot that overlaps a pin.
4. **No borrowed displays.** Rome adopts an X server only when it carries that name's marker, or, for a pinned name, when its display and RFB port match the pin. Openbox and websockify are matched by display and ports alone, because the entrypoint's WeChat processes carry no marker. That is safe because a slot's ports belong to the name once its X server does: Rome picks a slot only when its ports are free, or when the listening websockify is that name's own. A lock whose owner has exited is removed before a start.
5. **Desktops outlive Rome.** The processes run in their own sessions, detached from Rome, so a Rome restart or a `tsx --watch` reload leaves them running. They end with the container.
6. **Loopback only.** The X server's VNC port and websockify listen on loopback only. The only way in from outside is the guardian-gated upgrade on `/desktop-proxy/<name>/`.
7. **Small environment.** The processes get `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG` and the marker, and none of Rome's configuration or credentials.

Outside the container, where the desktop programs are not installed, `acquire` throws `DesktopUnavailable`.
