import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { saveSetting } from "@/lib/chat-api";
import { SETTINGS_QUERY_KEY, type SettingsMap, useSettings } from "@/hooks/use-settings";
import type { FoldPoint } from "@/components/chat/concierge-groups";

/** The setting that holds a chat's fold point, one per chat. */
function conciergeFoldKey(chatId: string): string {
  return `conciergeFold.${chatId}`;
}

function readFoldPoint(value: unknown): FoldPoint | null {
  if (!value || typeof value !== "object") return null;
  const { at, id } = value as Record<string, unknown>;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || typeof id !== "string") return null;
  return { at, id };
}

interface ConciergeFoldState {
  /** Where the fold ends, or null with no fold. */
  point: FoldPoint | null;
  /** Folds every message up to `point`. Resolves whether it was saved. */
  fold: (point: FoldPoint) => Promise<boolean>;
  /** Clears the fold. Resolves whether it was saved. */
  unfold: () => Promise<boolean>;
}

/**
 * A chat's fold point, kept in the instance's settings so every device that
 * opens the chat folds the same messages. It only changes what the transcript
 * draws: no message, task or memory is touched. A change shows at once and is
 * put back when the save fails.
 */
export function useConciergeFold(chatId: string | null): ConciergeFoldState {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const key = chatId ? conciergeFoldKey(chatId) : null;
  const stored = key ? settings?.[key] : undefined;
  const parsed = readFoldPoint(stored);
  // One object per stored point, so what memoizes on it keeps still.
  const point = useMemo(
    () => (parsed ? { at: parsed.at, id: parsed.id } : null),
    [parsed?.at, parsed?.id],
  );

  const save = useCallback(
    async (value: FoldPoint | null): Promise<boolean> => {
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

  const fold = useCallback((next: FoldPoint) => save(next), [save]);
  const unfold = useCallback(() => save(null), [save]);
  return { point, fold, unfold };
}
