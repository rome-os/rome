import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useSseEvents } from "@/hooks/use-sse-events";
import { useFileBrowserStoreApi } from "../store/context";
import {
  createFileBrowserEventsUrl,
  getAbsentDeletedWatchPaths,
  getFileBrowserWatchTopic,
  shouldReloadSelectedWatchFile,
  type FileBrowserWatchEvent,
  type FileBrowserWatchPathExists,
} from "@/lib/file-browser-watch";
import { FOLDER_TREE_DEPTH } from "../store/utils";

const fileWatchChangeSchema = z.object({
  at: z.number(),
  kind: z.enum(["add", "addDir", "change", "unlink", "unlinkDir"]),
  logicalRoot: z.string(),
  path: z.string(),
});

const fileWatchReadySchema = z.object({
  at: z.number(),
  logicalRoot: z.string(),
});

// `onError`'s readyState once the server refuses or ends the topic.
const SOURCE_CLOSED = 2;
const WATCH_RETRY_BASE_MS = 3_000;
const WATCH_RETRY_MAX_MS = 60_000;

/**
 * Watch reconciler. Watches `watchPaths` over the tab's live-events socket,
 * or the `/events` route where the API has no topic, and replays mutations
 * into the tree + selected file. Every `ready`, including the one after a
 * reconnect, rebaselines. Self-originated writes (writes we initiated
 * ourselves via the file slice) are suppressed for ≤3 events / 5 s so our own
 * saves don't trigger a reload race.
 */
export function useFileBrowserWatch(opts: { apiBasePath: string; watchPaths: string[] }) {
  const store = useFileBrowserStoreApi();
  const { apiBasePath, watchPaths } = opts;
  const watchEventsUrl = createFileBrowserEventsUrl(apiBasePath, watchPaths);
  // The URL encodes the path set, so it keys the topic as well.
  const baseTopic = useMemo(
    () => getFileBrowserWatchTopic(apiBasePath, watchPaths),
    [apiBasePath, watchEventsUrl],
  );
  // The server ends a watch whose watcher fails to start, and the client asks
  // for a refused topic again only after the socket reconnects. EventSource
  // retries the route on its own, so retry here with backoff, under a new
  // topic name because the refused one stays refused.
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retryFailuresRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const watchTopic =
    baseTopic && retryAttempt > 0
      ? { ...baseTopic, topic: `${baseTopic.topic}-${retryAttempt}` }
      : baseTopic;

  // A new path set subscribes a new topic at once, so a pending retry is moot.
  useEffect(
    () => () => {
      if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    },
    [watchEventsUrl],
  );

  const changeHandlerRef = useRef<(event: FileBrowserWatchEvent) => void>(() => {});
  const readyHandlerRef = useRef<(event: z.infer<typeof fileWatchReadySchema>) => void>(() => {});

  useEffect(() => {
    const { config } = store.getState();
    const { apiBasePath, logicalRootPath } = config;

    let pendingEvents: FileBrowserWatchEvent[] = [];
    let reloadTimer: number | null = null;
    let flushInProgress = false;
    let flushRequested = false;
    let reconcileGeneration = 0;
    let closed = false;

    const reloadCurrentSelection = async (): Promise<"loaded" | "missing" | "failed"> => {
      const state = store.getState();
      const currentSelectedPath = state.selection.selectedPath;
      if (!currentSelectedPath || state.file.hasUnsavedEdits()) return "loaded";
      return await state.file.loadFile(currentSelectedPath, {
        preserveDisplayedContent: true,
        preserveTreeSelection: true,
        syncUrl: false,
      });
    };

    const watchPathExistsAfterDelete: FileBrowserWatchPathExists = async (path, kind) => {
      const encodedPath = encodeURIComponent(path);
      const url =
        kind === "unlinkDir"
          ? `${apiBasePath}/tree?path=${encodedPath}&depth=${FOLDER_TREE_DEPTH}`
          : `${apiBasePath}/file?path=${encodedPath}`;
      try {
        const response = await fetch(url);
        if (response.status === 404) return false;
        if (response.status >= 500) return true;
        return response.ok;
      } catch {
        return true;
      }
    };

    const rebaseline = async () => {
      await store.getState().tree.loadRoot({ preserveExpandedChildren: true });
      if (closed) return;
      const state = store.getState();
      const currentSelectedPath = state.selection.selectedPath;
      if (currentSelectedPath && state.file.hasUnsavedEdits()) {
        const exists = await watchPathExistsAfterDelete(currentSelectedPath, "unlink");
        if (closed) return;
        if (!exists) {
          store.getState().watch.clearDeletedSelection(currentSelectedPath);
          return;
        }
      } else {
        const result = await reloadCurrentSelection();
        if (closed) return;
        if (currentSelectedPath && result === "missing") {
          store.getState().watch.clearDeletedSelection(currentSelectedPath);
          return;
        }
      }

      const currentSelectedFolderPath = store.getState().selection.selectedFolderPath;
      if (!currentSelectedFolderPath || currentSelectedFolderPath === logicalRootPath) return;
      try {
        const folderResponse = await fetch(
          `${apiBasePath}/tree?path=${encodeURIComponent(currentSelectedFolderPath)}&depth=${FOLDER_TREE_DEPTH}`,
        );
        if (!closed && folderResponse.status === 404) {
          store.getState().watch.clearDeletedSelection(currentSelectedFolderPath);
        }
      } catch {
        // Keep the current folder selection on transient rebaseline failures.
      }
    };

    const flushEvents = async () => {
      if (flushInProgress) {
        flushRequested = true;
        return;
      }
      flushInProgress = true;
      try {
        do {
          flushRequested = false;
          const runGeneration = reconcileGeneration;
          const events = pendingEvents;
          pendingEvents = [];
          if (events.length === 0) continue;

          const refreshedTree =
            (await store.getState().tree.loadRoot({ preserveExpandedChildren: true })) ?? [];
          if (closed) return;
          if (runGeneration !== reconcileGeneration) {
            pendingEvents = [...events, ...pendingEvents];
            flushRequested = true;
            continue;
          }

          const currentSelectedPath = store.getState().selection.selectedPath;
          const selectedFileChanged = shouldReloadSelectedWatchFile(
            events,
            currentSelectedPath,
            store.getState().file.isSelfOriginatedWatchEvent,
          );
          const deletedPaths = await getAbsentDeletedWatchPaths(
            events,
            watchPathExistsAfterDelete,
            { refreshedTree },
          );

          if (closed) return;
          if (runGeneration !== reconcileGeneration) {
            pendingEvents = [...events, ...pendingEvents];
            flushRequested = true;
            continue;
          }

          for (const deletedPath of deletedPaths) {
            store.getState().watch.clearDeletedSelection(deletedPath);
          }

          if (
            currentSelectedPath &&
            selectedFileChanged &&
            !store.getState().file.hasUnsavedEdits()
          ) {
            await reloadCurrentSelection();
          }
        } while (!closed && (flushRequested || pendingEvents.length > 0));
      } finally {
        flushInProgress = false;
      }
    };

    const scheduleReload = (event: FileBrowserWatchEvent) => {
      if (event.logicalRoot !== logicalRootPath) return;
      pendingEvents.push(event);
      reconcileGeneration += 1;
      if (flushInProgress) {
        flushRequested = true;
        return;
      }
      if (reloadTimer != null) window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null;
        void flushEvents();
      }, 150);
    };

    const handleReady = (event: z.infer<typeof fileWatchReadySchema>) => {
      if (event.logicalRoot === logicalRootPath) void rebaseline();
    };

    changeHandlerRef.current = scheduleReload;
    readyHandlerRef.current = handleReady;

    return () => {
      closed = true;
      changeHandlerRef.current = () => {};
      readyHandlerRef.current = () => {};
      if (reloadTimer != null) window.clearTimeout(reloadTimer);
    };
  }, [store, watchEventsUrl]);

  const handlers = {
    change: {
      schema: fileWatchChangeSchema,
      fn: (event: FileBrowserWatchEvent) => changeHandlerRef.current(event),
    },
    ready: {
      schema: fileWatchReadySchema,
      fn: (event: z.infer<typeof fileWatchReadySchema>) => {
        retryFailuresRef.current = 0;
        readyHandlerRef.current(event);
      },
    },
  };
  useLiveEvents(
    { topic: watchTopic?.topic ?? "", params: watchTopic?.params, sseUrl: watchEventsUrl },
    handlers,
    {
      enabled: watchTopic !== null,
      onError: ({ readyState }) => {
        if (readyState !== SOURCE_CLOSED || retryTimerRef.current != null) return;
        const delay = Math.min(
          WATCH_RETRY_BASE_MS * 2 ** retryFailuresRef.current,
          WATCH_RETRY_MAX_MS,
        );
        retryFailuresRef.current += 1;
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          setRetryAttempt((attempt) => attempt + 1);
        }, delay);
      },
    },
  );
  useSseEvents(watchEventsUrl, handlers, { enabled: watchTopic === null });
}
