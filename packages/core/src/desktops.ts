// Named desktops: a fixed table from name to X display and ports.
// scripts/docker/rome-start-desktop.sh starts them. Contract and invariants:
// docs/architecture/named-desktops.md.
export interface DesktopSlot {
  /** The X display, such as ":100". */
  display: string;
  vncPort: number;
  novncPort: number;
  /** The Openbox rc file for this desktop, when it needs one. */
  openboxConfig?: string;
}

type Env = NodeJS.ProcessEnv;

/**
 * Legacy `WECHAT_USER_DISPLAY`, which overrides the `wechat` desktop's display:
 * the one rule the table and startup validation share. Null while WeChat is
 * disabled or the variable is unset. Like the entrypoint, a value that is not
 * `:<number>`, or that names the shared display, is an error.
 */
export function wechatUserDisplay(env: Env = process.env): string | null {
  const display = env.WECHAT_USER_DISPLAY;
  if (env.WECHAT_USER_ENABLED !== "true" || !display) return null;
  const shared = env.DISPLAY || ":99";
  if (!/^:\d+$/.test(display) || display === shared) {
    throw new Error(`WECHAT_USER_DISPLAY must be a display like :100, other than ${shared}`);
  }
  return display;
}

/** Where the container image ships the desktop scripts. */
const DOCKER_SCRIPTS = "/opt/rome/scripts/docker";

/** The script that starts or reuses a desktop, as installed in the image. */
export const DESKTOP_SCRIPT = `${DOCKER_SCRIPTS}/rome-start-desktop.sh`;

/** The port in `value`, `fallback` when unset, or null when `value` is not an
 *  integer from 1 to 65535. */
function port(value: string | undefined, fallback: number): number | null {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

/** WeChat's own display while WeChat is enabled: `:100` with RFB 5901 and
 *  websockify 6081, which legacy `WECHAT_USER_DISPLAY`, `ROME_WECHAT_VNC_PORT`
 *  and `ROME_WECHAT_NOVNC_PORT` override. A value `wechatUserDisplay` rejects,
 *  a port outside 1–65535, or a default display that is the shared one gives no
 *  desktop, so the proxy fails closed. */
function wechat(env: Env): DesktopSlot | null {
  if (env.WECHAT_USER_ENABLED !== "true") return null;
  let display: string;
  try {
    display = wechatUserDisplay(env) ?? ":100";
  } catch {
    return null;
  }
  if (display === (env.DISPLAY || ":99")) return null;
  const vncPort = port(env.ROME_WECHAT_VNC_PORT, 5901);
  const novncPort = port(env.ROME_WECHAT_NOVNC_PORT, 6081);
  if (vncPort === null || novncPort === null) return null;
  return {
    display,
    vncPort,
    novncPort,
    openboxConfig: `${DOCKER_SCRIPTS}/wechat-openbox-rc.xml`,
  };
}

const DESKTOPS: Record<string, (env: Env) => DesktopSlot | null> = { wechat };

/** The slot of the desktop called `name`, or null when no such desktop exists
 *  in this configuration. Pure: it reads the environment and never looks at
 *  processes, so a slot says where the desktop lives, not that it is running. */
export function desktopSlot(name: string, env: Env = process.env): DesktopSlot | null {
  return Object.hasOwn(DESKTOPS, name) ? DESKTOPS[name]!(env) : null;
}

/** The arguments `rome-start-desktop.sh` takes for this desktop. */
export function startDesktopArgs(name: string, slot: DesktopSlot): string[] {
  return [
    name,
    slot.display,
    String(slot.vncPort),
    String(slot.novncPort),
    ...(slot.openboxConfig ? [slot.openboxConfig] : []),
  ];
}
