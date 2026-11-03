import { useCallback, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

/** Where the router's own history entry sits in the session, from 0. */
function historyIndex(): number {
  const state: unknown = window.history.state;
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
}

export interface HistoryNav {
  canGoBack: boolean;
  canGoForward: boolean;
  back: () => void;
  forward: () => void;
}

/**
 * Back and forward through the dashboard's own history, for a window with no
 * browser toolbar.
 *
 * The router numbers each entry it creates (`history.state.idx`), so back is
 * open past the first one. The browser does not say whether a forward entry
 * exists, so this keeps the highest index the session has reached and drops it
 * to the current one on every push, which discards the forward entries the
 * same way the browser does. A reload forgets that high mark, so forward stays
 * shut until the person goes back again.
 */
export function useHistoryNav(): HistoryNav {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const [position, setPosition] = useState(() => {
    const index = historyIndex();
    return { key: location.key, index, last: index };
  });
  // Adjusted during render rather than in an effect, so the buttons are right
  // on the same paint as the page they lead away from.
  if (position.key !== location.key) {
    const index = historyIndex();
    setPosition({
      key: location.key,
      index,
      last: navigationType === "PUSH" ? index : Math.max(position.last, index),
    });
  }

  const back = useCallback(() => navigate(-1), [navigate]);
  const forward = useCallback(() => navigate(1), [navigate]);

  return {
    canGoBack: position.index > 0,
    canGoForward: position.index < position.last,
    back,
    forward,
  };
}
