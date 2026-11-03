import { isApplePlatform } from "@/lib/platform";

function currentPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export function chatSearchShortcutForPlatform(platform = currentPlatform()): string {
  return isApplePlatform(platform) ? "⌘K" : "Ctrl K";
}

export function isChatSearchShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = currentPlatform(),
): boolean {
  const modifier = isApplePlatform(platform) ? event.metaKey : event.ctrlKey;
  return modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}
