import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { ChatOutputDto, ChatOutputsResponse } from "@rome/api-types/chat-outputs";
import { fetchJson } from "@/lib/fetch-json";

export const chatOutputsKey = (chatId: string) => ["chat-outputs", chatId] as const;

const listUrl = (chatId: string) => `/api/chat/sessions/${encodeURIComponent(chatId)}/outputs`;

/** Chat `chatId`'s outputs, newest first; nothing while there is no chat. */
export function useChatOutputs(chatId: string | null) {
  return useQuery({
    queryKey: chatOutputsKey(chatId ?? ""),
    queryFn: () =>
      fetchJson<ChatOutputsResponse>(listUrl(chatId ?? ""), {
        fallback: "Failed to load outputs",
      }),
    enabled: Boolean(chatId),
    select: (response) => response.outputs,
  });
}

/**
 * The output a chat message's link points at: a link to a file in the
 * projects folder (its decoded `/projects/…` path) or to a shown copy
 * (`/api/assets/…`). Undefined for any other link, a folder's included.
 */
export function outputOfLink(
  outputs: readonly ChatOutputDto[] | undefined,
  path: string,
): ChatOutputDto | undefined {
  if (!outputs) return undefined;
  const bare = path.split(/[?#]/)[0] ?? path;
  return outputs.find((output) => output.link !== null && output.link === bare);
}

/** What a message link in a chat asks of the chat's outputs. */
export interface OutputLinks {
  /**
   * Opens the Outputs tab on the output `path` links to and answers true, or
   * answers false when `path` is none of the chat's outputs.
   */
  open: (path: string) => boolean;
}

export const OutputLinksContext = createContext<OutputLinks | null>(null);

/** The chat's outputs as message links see them, or null outside a chat. */
export function useOutputLinks(): OutputLinks | null {
  return useContext(OutputLinksContext);
}

export type ChatOutput = ChatOutputDto;
