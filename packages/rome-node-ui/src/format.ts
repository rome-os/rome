// Turns action rows into the words and numbers the device pages show.
import type { NodeActionResult, NodeActionRow } from "./protocol.js";

/** Mirrors the daemon's result rule in packages/rome-node-core/src/observe.ts. */
export function resultOf(row: NodeActionRow): NodeActionResult {
  if (row.endedAt === null) return "running";
  if (row.outcome === "ok")
    return (row.exitCode ?? 0) === 0 && !row.signal ? "succeeded" : "failed";
  return row.outcome === "error" ? "failed" : "no_result";
}

/** Returns the shell and script of a `bash -lc` or `powershell -Command` exec, or null. */
export function scriptOf(row: NodeActionRow): { shell: string; script: string } | null {
  if (!row.command || !Array.isArray(row.args)) return null;
  const shell = (row.command.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  if (["bash", "sh", "zsh", "dash"].includes(shell)) {
    const flag = row.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag >= 0 && row.args[flag + 1] !== undefined)
      return { shell, script: row.args[flag + 1]! };
  }
  if (shell === "powershell" || shell === "pwsh") {
    const flag = row.args.findIndex((arg) => /^-(command|c)$/i.test(arg));
    if (flag >= 0 && row.args[flag + 1] !== undefined)
      return { shell, script: row.args.slice(flag + 1).join(" ") };
  }
  return null;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));

/** The command as one line: a shell script with its lines joined, or the quoted argv. */
export function summarize(row: NodeActionRow): string {
  if (row.transfer) {
    const { direction, localPath, remotePath } = row.transfer;
    return direction === "push" ? `${localPath} → ${remotePath}` : `${remotePath} → ${localPath}`;
  }
  const script = scriptOf(row);
  // Scripts often open with setup lines such as `set -e`, so one line shows them all.
  if (script)
    return script.script
      .split("\n")
      .map((text) => text.trim())
      .filter(Boolean)
      .join("; ");
  if (row.command)
    return [row.command, ...(Array.isArray(row.args) ? row.args : [])].map(quote).join(" ");
  return `${row.action} ${typeof row.args === "string" ? row.args : ""}`.trim();
}

/** The full command text for copying: the script as written, or the quoted argv. */
export function commandText(row: NodeActionRow): string {
  const script = scriptOf(row);
  if (script) return script.script;
  if (row.command && Array.isArray(row.args))
    return [row.command, ...row.args].map(quote).join(" ");
  return summarize(row);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.floor(seconds % 60)} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function byteFormat(locale: string | undefined) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  const formats = units.map(
    (unit) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }),
  );
  return (bytes: number) => {
    let value = bytes;
    let step = 0;
    while (value >= 1024 && step < units.length - 1) {
      value /= 1024;
      step++;
    }
    return formats[step]!.format(value);
  };
}

/** `14:32:08`, or `14:32` without seconds, in the 24-hour clock of the locale. */
export function clock(time: number, locale: string | undefined, seconds = true): string {
  return new Date(time).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
}

/** Midnight before `time`, local time. */
export function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export type DeviceKind = "server" | "laptop" | "desktop" | "phone";

/** Reads the kind and display name of a platform such as `linux`, `darwin`, or `win32`. */
export function platformOf(platform: string | null | undefined): {
  kind: DeviceKind;
  label: string | null;
} {
  const value = platform?.toLowerCase() ?? "";
  if (value.startsWith("darwin") || value.startsWith("mac"))
    return { kind: "laptop", label: "macOS" };
  if (value.startsWith("win")) return { kind: "desktop", label: "Windows" };
  if (value.startsWith("ios")) return { kind: "phone", label: "iOS" };
  if (value.startsWith("android")) return { kind: "phone", label: "Android" };
  if (value.startsWith("linux")) return { kind: "server", label: "Linux" };
  return { kind: "server", label: platform || null };
}
