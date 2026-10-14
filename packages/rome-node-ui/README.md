# @rome-os/node-ui

A React console for one rome-node daemon: its Gateway connection, the actions running now, and
the action history with search and filters. Rome's dashboard mounts it in Settings → Devices.
A Desktop entry can mount the same component.

```tsx
import { NodeConsole } from "@rome-os/node-ui";

<NodeConsole
  url="wss://rome.example/ws/node"
  devices={[{ id: "7c9e6679-…", name: "MacBook Pro" }]}
  locale="zh-CN"
/>;
```

- `url` is a WebSocket endpoint that forwards the daemon's observation methods unchanged, such as
  Rome Core's `/ws/node`. A backend builds one with `openConsoleBridge` from
  `@rome-os/node-core/client`. The protocol is in [docs/rome-node.md](../../docs/rome-node.md#activity-log).
- `devices` maps device IDs to names. Unknown IDs show as the ID.
- `locale` picks Chinese for `zh*` and English otherwise, and formats dates and sizes.

The component renders cards only, so the host supplies the section heading. It is styled with
`@rome-os/ui` and Tailwind. Import both stylesheets into the host's Tailwind entry:

```css
@import "@rome-os/ui/styles.css";
@import "@rome-os/node-ui/styles.css";
```
