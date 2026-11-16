import { useEffect } from "react";
import { useFileBrowserStoreApi } from "../store/context";
import { clampSidebarWidth } from "../store/utils";
import { readStored } from "@/lib/stored-preference";

export function usePersistedSidebarWidth(logicalRootPath: string) {
  const store = useFileBrowserStoreApi();
  const sidebarStorageKey = `rome:file-browser:${logicalRootPath}:sidebar-width`;

  useEffect(() => {
    const storedWidth = readStored(sidebarStorageKey);
    if (!storedWidth) return;
    const parsedWidth = Number(storedWidth);
    if (Number.isFinite(parsedWidth)) {
      store.setState((state) => ({
        ui: { ...state.ui, sidebarWidth: clampSidebarWidth(parsedWidth) },
      }));
    }
  }, [sidebarStorageKey, store]);

  return sidebarStorageKey;
}
