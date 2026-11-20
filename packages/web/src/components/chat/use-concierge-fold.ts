import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { saveSetting } from "@/lib/chat-api";
import { SETTINGS_QUERY_KEY, type SettingsMap, useSettings } from "@/hooks/use-settings";

/** The setting that holds a chat's fold point, one per chat. */
function conciergeFoldKey(chatId: string): string {
  return `conciergeFold.${chatId}`;
}

interface ConciergeFoldPoint {
  /** ISO timestamp: the messages sent at or before it are folded, or null with no fold. */
  through: string | null;
  /** Folds every message sent at or before `through`. Resolves whether it was saved. */
  fold: (through: string) => Promise<boolean>;
  /** Clears the fold. Resolves whether it was saved. */
  unfold: () => Promise<boolean>;
}

/**
 * A chat's fold point, kept in the instance's settings so every device that
 * opens the chat folds the same messages. It only changes what the transcript
 * draws: no message, task or memory is touched. A change shows at once and is
 * put back when the save fails.
 */
export function useConciergeFold(chatId: string | null): ConciergeFoldPoint {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const key = chatId ? conciergeFoldKey(chatId) : null;
  const stored = key ? settings?.[key] : undefined;
  const through = typeof stored === "string" && !Number.isNaN(Date.parse(stored)) ? stored : null;

  const save = useCallback(
    async (value: string | null): Promise<boolean> => {
      if (!key) return false;
      const before = queryClient.getQueryData<SettingsMap>(SETTINGS_QUERY_KEY);
      // Settings not read yet have nothing to draw ahead of the save from.
      if (before)
        queryClient.setQueryData<SettingsMap>(SETTINGS_QUERY_KEY, { ...before, [key]: value });
      const ok = await saveSetting(key, value).catch(() => false);
      if (!ok && before) queryClient.setQueryData(SETTINGS_QUERY_KEY, before);
      if (!before) await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      return ok;
    },
    [key, queryClient],
  );

  const fold = useCallback((at: string) => save(at), [save]);
  const unfold = useCallback(() => save(null), [save]);
  return { through, fold, unfold };
}
