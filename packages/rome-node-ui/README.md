# @rome-os/node-ui

React pages for the activity of one rome-node daemon. `NodeDevices` is the overview: the
devices linked to the account, each active one with its 24-hour counts, load chart, and latest
commands. `NodeDeviceActivity` is one device's page: the load chart, a result filter, search, the
command list, and the selected command's detail. Rome's dashboard mounts them at Settings →
Devices and `/settings/devices/<id>`. A Desktop entry can mount the same components.

```tsx
import { NodeDeviceActivity, NodeDevices, type NodeNavigation } from "@rome-os/node-ui";

const navigation: NodeNavigation = {
  href: (deviceId, commandId) =>
    deviceId === null ? "/devices" : `/devices/${deviceId}${commandId ? `?command=${commandId}` : ""}`,
  navigate: (href) => router.push(href),
};

<NodeDevices
  url="wss://rome.example/ws/node"
  devices={[{ id: "7c9e6679-…", name: "MacBook Pro", platform: "darwin", status: "connected" }]}
  navigation={navigation}
  locale="zh-CN"
/>;

<NodeDeviceActivity
  url="wss://rome.example/ws/node"
  device={{ id: "7c9e6679-…", name: "MacBook Pro", platform: "darwin" }}
  selected={commandId}
  onSelect={setCommandId}
/>;
```

- `url` is a WebSocket endpoint that forwards the daemon's observation methods unchanged, such as
  Rome Core's `/ws/node`. A backend builds one with `openConsoleBridge` from
  `@rome-os/node-core/client`. The protocol is in [docs/rome-node.md](../../docs/rome-node.md#activity-log).
- `devices` are the devices linked to the account. Activity from an unlisted id shows under the
  id.
- `navigation` lets the host own routing. Cards render real links from `href`, and a plain click
  calls `navigate`.
- `locale` picks Chinese for `zh*` and English otherwise, and formats dates and numbers.

The pages are styled with `@rome-os/ui` and Tailwind. Import both stylesheets into the host's
Tailwind entry:

```css
@import "@rome-os/ui/styles.css";
@import "@rome-os/node-ui/styles.css";
```
