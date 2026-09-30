// Named desktops: a fixed table from name to X display and ports.
// scripts/docker/rome-start-desktop.sh starts them. Contract and invariants:
// docs/architecture/named-desktops.md.
import { wechatUserDisplay } from "./channels/wechat-user.js";

export interface DesktopSlot {
  /** The X display, such as ":100". */
  display: string;
  vncPort: number;
  novncPort: number;
}

type Env = NodeJS.ProcessEnv;

function port(value: string | undefined, fallback: number): number {
  return value ? Number(value) : fallback;
}

/** WeChat's own display while `wechatUserDisplay` names one, with RFB
 *  `ROME_WECHAT_VNC_PORT` (5901) and websockify `ROME_WECHAT_NOVNC_PORT` (6081).
 *  A value that rule rejects gives no desktop, so the proxy fails closed. */
function wechat(env: Env): DesktopSlot | null {
  let display: string | null;
  try {
    display = wechatUserDisplay(env);
  } catch {
    return null;
  }
  if (!display) return null;
  return {
    display,
    vncPort: port(env.ROME_WECHAT_VNC_PORT, 5901),
    novncPort: port(env.ROME_WECHAT_NOVNC_PORT, 6081),
  };
}

const DESKTOPS: Record<string, (env: Env) => DesktopSlot | null> = { wechat };

/** The slot of the desktop called `name`, or null when no such desktop exists
 *  in this configuration. Pure: it reads the environment and never looks at
 *  processes, so a slot says where the desktop lives, not that it is running. */
export function desktopSlot(name: string, env: Env = process.env): DesktopSlot | null {
  return Object.hasOwn(DESKTOPS, name) ? DESKTOPS[name]!(env) : null;
}
