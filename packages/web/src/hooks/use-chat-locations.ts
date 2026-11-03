import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { listChatLocations } from "@/lib/chat-api";
import type { ChatLocations, ProjectOption } from "@/lib/chat-types";

const chatLocationsKey = ["chat-locations"] as const;

/**
 * The new-chat location menu's projects and devices, from one request. It
 * loads as soon as `enabled`, ahead of the menu, and every composer shares the
 * cached answer.
 */
export function useChatLocations(enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: chatLocationsKey,
    queryFn: listChatLocations,
    enabled,
    staleTime: 30_000,
  });
  /** Adds a project the guardian just created, so the menu shows it without a reload. */
  const addProject = useCallback(
    (project: ProjectOption) => {
      queryClient.setQueryData<ChatLocations>(chatLocationsKey, (current) =>
        current
          ? {
              ...current,
              projects: {
                ...current.projects,
                projects: [...current.projects.projects, project].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              },
            }
          : current,
      );
    },
    [queryClient],
  );
  return { query, addProject };
}
