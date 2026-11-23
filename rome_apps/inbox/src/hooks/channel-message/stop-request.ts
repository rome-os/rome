import { isStopCommand } from "@rome-os/app-runtime";

/**
 * A stop: `/stop`, alone or after mentions, as in "@Rome /stop". Connections
 * report the text as typed, mentions included, so the mentions are skipped
 * here. Whether it was said to Rome is the message's addressing.
 */
export function isStopRequest(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  const stop = /(?:^|\s)(\S+)$/.exec(trimmed);
  if (!stop || !isStopCommand(stop[1])) return false;
  const before = trimmed.slice(0, stop.index).trim();
  return before === "" || before.startsWith("@");
}
