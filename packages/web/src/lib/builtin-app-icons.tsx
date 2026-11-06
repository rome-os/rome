import { FileClock, Inbox, LayoutGrid, Zap } from "lucide-react";
import type { ComponentType } from "react";
import { RomeLogo } from "@/components/logo";
import { cn } from "@/lib/utils";

type BuiltinAppIconProps = { className?: string; "aria-hidden"?: boolean };
type BuiltinAppIcon = ComponentType<BuiltinAppIconProps>;

function WelcomeAppIcon({ className, ...props }: BuiltinAppIconProps) {
  return <RomeLogo {...props} className={cn(className, "scale-80")} cutoutFace />;
}

// These first-party apps share Rome's page icon treatment. Keep every other
// app's self-painted icon.
const BUILTIN_APP_ICONS: ReadonlyMap<string, BuiltinAppIcon> = new Map<string, BuiltinAppIcon>([
  ["briefing", FileClock],
  ["inbox", Inbox],
  ["showcases", LayoutGrid],
  ["skills", Zap],
  ["welcome-to-rome", WelcomeAppIcon],
]);

export function getBuiltinAppIcon(appId: string): BuiltinAppIcon | undefined {
  return BUILTIN_APP_ICONS.get(appId);
}
