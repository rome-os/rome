import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useFileBrowserStoreApi } from "../store/context";

/**
 * Intercepts plain left-clicks on in-app anchors when we have unsaved edits,
 * so the user gets the same confirm-on-leave flow we use for file/folder
 * selection changes.
 *
 * With `handBack`, the browser is a guest in a page that owns its links, as a
 * chat's Outputs tab is: once the edits are settled the click goes back to the
 * link to handle as it would have, instead of navigating to the href here.
 */
export function useDocumentLinkInterceptor({ handBack = false }: { handBack?: boolean } = {}) {
  const store = useFileBrowserStoreApi();
  const navigate = useNavigate();

  useEffect(() => {
    let handingBack = false;
    const handleDocumentClick = (event: globalThis.MouseEvent) => {
      const fileSlice = store.getState().file;
      if (
        handingBack ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !fileSlice.hasUnsavedEdits()
      ) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.download || (anchor.target && anchor.target !== "_self")) return;

      const nextUrl = new URL(anchor.href, window.location.href);
      const currentUrl = new URL(window.location.href);
      if (
        nextUrl.origin === currentUrl.origin &&
        nextUrl.pathname === currentUrl.pathname &&
        nextUrl.search === currentUrl.search &&
        nextUrl.hash === currentUrl.hash
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void fileSlice.resolveUnsavedEditsBeforeLeaving().then((canLeave) => {
        if (!canLeave) return;
        if (handBack && nextUrl.origin === currentUrl.origin) {
          // Settled, so the repeated click is not held again; `handingBack`
          // keeps it from looping if some edit is still counted as unsaved.
          handingBack = true;
          try {
            anchor.click();
          } finally {
            handingBack = false;
          }
          return;
        }
        if (nextUrl.origin === currentUrl.origin) {
          const nextBrowserPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
          store.getState().refs.acceptedBrowserPath = nextBrowserPath;
          navigate(nextBrowserPath);
          return;
        }
        store.getState().file.setSuppressNextBeforeUnload(true);
        window.location.assign(nextUrl.href);
      });
    };

    document.addEventListener("click", handleDocumentClick, true);
    return () => document.removeEventListener("click", handleDocumentClick, true);
  }, [handBack, navigate, store]);
}
