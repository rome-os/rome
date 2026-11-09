import { FileClock, Inbox, LayoutGrid, Zap } from "lucide-react";
import type { ComponentType } from "react";

type BuiltinAppIconProps = { className?: string; "aria-hidden"?: boolean };
type BuiltinAppIcon = ComponentType<BuiltinAppIconProps>;

// These first-party apps share Rome's page icon treatment. Keep every other
// app's self-painted icon.
const BUILTIN_APP_ICONS: ReadonlyMap<string, BuiltinAppIcon> = new Map<string, BuiltinAppIcon>([
  ["briefing", FileClock],
  ["inbox", Inbox],
  ["showcases", LayoutGrid],
  ["skills", Zap],
]);

export function getBuiltinAppIcon(appId: string): BuiltinAppIcon | undefined {
  return BUILTIN_APP_ICONS.get(appId);
}
