import type { ChatSession } from "@/lib/chat-types";

export function activeSessionFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function sessionActivityTime(session: ChatSession): number {
  return new Date(session.activityAt).getTime();
}
