import type { OpenWaitItem } from "../webchat/repository.js";

/** Each chat waiting on one approval since the given time, as `openWaitsOf` reads it. */
export function approvalWaits(since: Map<string, number>): Map<string, OpenWaitItem[]> {
  return new Map(
    [...since].map(([chatId, at]) => [
      chatId,
      [{ kind: "approval" as const, id: `approval-${chatId}`, since: at }],
    ]),
  );
}
