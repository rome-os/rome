/**
 * the setup polling runner. A single hook every service's connect
 * card uses: start (or re-attach to) a grant's setup, submit input, cancel,
 * and poll while the coroutine awaits an external event (a `presenting` state).
 * The hook is transport-only; rendering is the standard renderers' job.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelSetup,
  getSetupState,
  startSetup,
  submitSetupInput,
  type SetupState,
} from "@/lib/setup-api";

export interface UseSetupOptions {
  /** Connection id, or the bare service name for a never-connected service. */
  idOrService: string;
  grant: string;
  /** A live setup id discovered on the connection response — the hook
   *  re-attaches to it (polls its state) instead of starting fresh. */
  activeCid?: string | null;
  /** Fired once when the setup reaches `done` — the card refreshes
   *  connections so the slot flips to connected. */
  onDone?: () => void;
}

// Poll interval while the setup awaits an external event.
const POLL_MS = 2000;

export interface SetupRunner {
  cid: string | null;
  state: SetupState | null;
  busy: boolean;
  error: string | null;
  start: (force?: boolean) => void;
  submit: (answers: Record<string, string>) => void;
  cancel: () => void;
  /** Drop all local setup state (cid, state, busy, error). The card calls this
   *  after a disconnect so a stale terminal `done`/`cancelled` view doesn't block
   *  a fresh Connect in the same detail view. */
  reset: () => void;
}

export function useSetup(options: UseSetupOptions): SetupRunner {
  const { idOrService, grant, activeCid, onDone } = options;
  const [cid, setCid] = useState<string | null>(activeCid ?? null);
  const [state, setState] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doneFiredRef = useRef(false);
  // The cid reset() dropped: the adopt effect must not immediately re-adopt it
  // from a stale `activeCid` discovery (the refresh that clears the discovery
  // races the reset). A fresh start() supersedes the dismissal.
  const dismissedCidRef = useRef<string | null>(null);

  const settle = useCallback(
    (next: SetupState) => {
      setState(next);
      if (next.status === "done" && !doneFiredRef.current) {
        doneFiredRef.current = true;
        onDone?.();
      }
    },
    [onDone],
  );

  const reset = useCallback(() => {
    setCid((current) => {
      dismissedCidRef.current = current;
      return null;
    });
    setState(null);
    setBusy(false);
    setError(null);
    doneFiredRef.current = false;
  }, []);

  // Adopt a discovered live setup (re-attach on reopen). Reset the local state
  // when switching to a different setup so the poll effect actually re-attaches
  // (a retained terminal state would otherwise suppress polling). A cid the
  // card explicitly reset() is not re-adopted.
  useEffect(() => {
    if (activeCid && activeCid !== cid && activeCid !== dismissedCidRef.current) {
      setCid(activeCid);
      setState(null);
      doneFiredRef.current = false;
    }
  }, [activeCid, cid]);

  const start = useCallback(
    (force = false) => {
      setBusy(true);
      setError(null);
      void (async () => {
        const result = await startSetup(idOrService, grant, { force });
        setBusy(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        doneFiredRef.current = false;
        dismissedCidRef.current = null;
        setCid(result.start.cid);
        settle(result.start.state);
      })();
    },
    [idOrService, grant, settle],
  );

  const submit = useCallback(
    (answers: Record<string, string>) => {
      if (!cid) return;
      setBusy(true);
      setError(null);
      void (async () => {
        const result = await submitSetupInput(cid, answers);
        setBusy(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        settle(result.outcome.state);
      })();
    },
    [cid, settle],
  );

  const cancel = useCallback(() => {
    if (!cid) return;
    setBusy(true);
    void (async () => {
      const next = await cancelSetup(cid);
      setBusy(false);
      if (next) settle(next);
    })();
  }, [cid, settle]);

  // Poll while the coroutine awaits an external event — the states that change
  // without guardian input on this page. `awaiting-redirect` is one of them
  // whenever the hand-off went to the system browser (the desktop shell): the
  // return leg resumes the coroutine in that other browser, so this window
  // learns the setup connected only by asking.
  useEffect(() => {
    if (!cid) return;
    if (state && state.status !== "presenting" && state.status !== "awaiting-redirect") return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const next = await getSetupState(cid);
      if (cancelled) return;
      if (!next) {
        // The setup is gone (e.g. a server restart lost the in-memory session):
        // drop the stale state so the card can offer a fresh start.
        reset();
        return;
      }
      settle(next);
    };
    const handle = setInterval(() => void tick(), POLL_MS);
    // Fetch once immediately when we (re-)attach to an unseen setup.
    if (!state) void tick();
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [cid, state, settle, reset]);

  return { cid, state, busy, error, start, submit, cancel, reset };
}
