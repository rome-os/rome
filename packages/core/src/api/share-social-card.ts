import type { WebChatRepository } from "../db/repositories/webchat.js";
import { getExternalRequestOrigin } from "../lib/request-origin.js";
import type { SocialCard } from "../lib/social-meta.js";

const SHARE_ROUTE_RE = /^\/share\/([^/]+)\/?$/;

/** Longest share title a card shows, in characters, before an ellipsis. */
const MAX_TITLE_LENGTH = 70;

/**
 * The line every share card carries. It is fixed: a card is read by whoever
 * the link is pasted to, so it never quotes the shared message. English,
 * since the shell's language is picked per browser and the server has none.
 */
export const SHARE_CARD_DESCRIPTION = "From Rome · Your personal assistant";

export interface ShareSocialCardDeps {
  webchatRepo: Pick<WebChatRepository, "getSharedChat">;
}

function cardTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
}

/**
 * The social card for a `/share/<token>` document, or null when the token
 * names no live share (or a share with no title), so the shell keeps its
 * generic card. The image is left unset: the shell's own og:image stays.
 */
export async function buildShareSocialCard(
  deps: ShareSocialCardDeps,
  request: Request,
): Promise<SocialCard | null> {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(SHARE_ROUTE_RE);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const share = await deps.webchatRepo.getSharedChat(token);
  const title = share ? cardTitle(share.title) : "";
  if (!title) return null;
  // Echoes the requested host, as the app cards do: the crawler already
  // holds this URL.
  const { origin } = getExternalRequestOrigin(request);
  return { title, description: SHARE_CARD_DESCRIPTION, url: `${origin}${pathname}` };
}
