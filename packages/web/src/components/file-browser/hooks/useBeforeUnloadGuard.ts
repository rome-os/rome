import { useEffect } from "react";
import { useFileBrowserStore, useFileBrowserStoreApi } from "../store/context";

export function useBeforeUnloadGuard() {
  const store = useFileBrowserStoreApi();
  const uploading = useFileBrowserStore((state) => state.ui.uploadProgress !== null);

  // Upload protection must not inherit the editor's one-shot navigation exemption.
  useEffect(() => {
    if (!uploading) return;
    const handleUploadBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleUploadBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleUploadBeforeUnload);
  }, [uploading]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const file = store.getState().file;
      if (file._suppressNextBeforeUnload) {
        file._suppressNextBeforeUnload = false;
        return;
      }
      if (file._manualSaveInFlight) {
        event.preventDefault();
        event.returnValue = "";
        return;
      }
      if (!store.getState().file.hasUnsavedEdits()) return;
      if (file._autoSaveCanRecover) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [store]);
}
