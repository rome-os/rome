// State of a rome-node daemon, read over a console socket that carries the daemon's JSON-RPC
// unchanged. Wire contract: ./protocol.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  nodeActionRowSchema,
  nodeConsoleDaemonStateSchema,
  nodeEventSchema,
  nodeLogResultSchema,
  nodeStatusSchema,
  type NodeActionQuery,
  type NodeActionRow,
  type NodeConsoleDaemonState,
  type NodeOutcome,
  type NodeStatus,
} from "./protocol.js";

const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 15_000];

type NodeConsoleLink = "connecting" | "open" | NodeConsoleDaemonState;

export interface NodeConsoleFilters {
  direction?: "in" | "out";
  peer?: string;
  outcome?: NodeOutcome[];
  /** Ignored below three characters, the daemon's minimum. */
  text?: string;
}

export interface NodeConsoleState {
  link: NodeConsoleLink;
  status: NodeStatus | null;
  running: NodeActionRow[];
  history: NodeActionRow[];
  hasMore: boolean;
  loadingHistory: boolean;
  loadMore(): void;
}

const actionsResultSchema = nodeLogResultSchema(nodeActionRowSchema);

export function activeTextFilter(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed && [...trimmed].length >= 3 ? trimmed : undefined;
}

function matches(row: NodeActionRow, filters: NodeConsoleFilters): boolean {
  if (filters.direction && row.direction !== filters.direction) return false;
  if (filters.peer && row.peer !== filters.peer) return false;
  if (filters.outcome?.length && (!row.outcome || !filters.outcome.includes(row.outcome)))
    return false;
  // Substring matching belongs to the daemon's index, so a text filter shows only fetched rows.
  return !activeTextFilter(filters.text);
}

function actionQuery(filters: NodeConsoleFilters, before?: number): NodeActionQuery {
  const text = activeTextFilter(filters.text);
  return {
    kind: "actions",
    limit: PAGE_SIZE,
    ...(before === undefined ? {} : { before }),
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.peer ? { peer: filters.peer } : {}),
    ...(filters.outcome?.length ? { outcome: filters.outcome } : {}),
    ...(text ? { text } : {}),
  };
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: number };

/** One console socket. `request` rejects when the socket closes before the reply. */
class ConsoleSocket {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly socket: WebSocket;

  constructor(
    url: string,
    handlers: {
      open(): void;
      event(value: unknown): void;
      daemon(state: NodeConsoleDaemonState): void;
      close(): void;
    },
  ) {
    this.socket = new WebSocket(url);
    this.socket.onopen = () => handlers.open();
    this.socket.onmessage = (message) => {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (value.method === "events.node") {
        handlers.event(value.params);
        return;
      }
      if (value.method === "console.daemon") {
        const state = nodeConsoleDaemonStateSchema.safeParse(
          (value.params as { state?: unknown } | undefined)?.state,
        );
        if (state.success) handlers.daemon(state.data);
        return;
      }
      const pending = typeof value.id === "number" ? this.pending.get(value.id) : undefined;
      if (!pending) return;
      this.pending.delete(value.id as number);
      window.clearTimeout(pending.timer);
      if ("result" in value) pending.resolve(value.result);
      else pending.reject(new Error(String((value.error as { message?: unknown })?.message)));
    };
    this.socket.onclose = () => {
      for (const pending of this.pending.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new Error("closed"));
      }
      this.pending.clear();
      handlers.close();
    };
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    this.socket.onclose = null;
    this.socket.close();
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("closed"));
    }
    this.pending.clear();
  }
}

/**
 * Follows the daemon behind `url` while mounted. A new `url` opens a new socket. The socket
 * reconnects with backoff, and each connection reloads the first history page, which fills any
 * gap the disconnect left.
 */
export function useNodeConsole(url: string, filters: NodeConsoleFilters): NodeConsoleState {
  const [link, setLink] = useState<NodeConsoleLink>("connecting");
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [running, setRunning] = useState<Map<number, NodeActionRow>>(new Map());
  const [history, setHistory] = useState<NodeActionRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [generation, setGeneration] = useState(0);
  const socketRef = useRef<ConsoleSocket | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const filterKey = JSON.stringify(actionQuery(filters));

  useEffect(() => {
    // Every supported browser has WebSocket. Test DOMs and embedded views may not.
    if (typeof WebSocket === "undefined") return;
    let disposed = false;
    let attempt = 0;
    let retry: number | undefined;
    const connect = () => {
      setLink("connecting");
      let daemonState: NodeConsoleDaemonState | null = null;
      const socket: ConsoleSocket = new ConsoleSocket(url, {
        open: () => {
          setLink("open");
          void socket
            .request("events.subscribe", { topic: "node" })
            .then(() => {
              attempt = 0;
              setGeneration((value) => value + 1);
            })
            .catch(() => {});
        },
        event: (value) => {
          const parsed = nodeEventSchema.safeParse(value);
          if (!parsed.success || disposed) return;
          const event = parsed.data;
          if (event.type === "snapshot") {
            setStatus(event.status);
            setRunning(new Map(event.running.map((row) => [row.id, row])));
          } else if (event.type === "connection") {
            setStatus((current) => {
              const role = current?.roles[event.role];
              if (!current || !role) return current;
              return {
                ...current,
                roles: {
                  ...current.roles,
                  [event.role]: { ...role, connection: event.status, since: event.at },
                },
              };
            });
            // The reconnect count is the daemon's, so read it again rather than derive it here.
            void socket
              .request("node.status", {})
              .then((next) => {
                const parsed = nodeStatusSchema.safeParse(next);
                if (parsed.success && !disposed) setStatus(parsed.data);
              })
              .catch(() => {});
          } else {
            setRunning((current) => {
              const next = new Map(current);
              if (event.phase === "start") next.set(event.id, event.row);
              else next.delete(event.id);
              return next;
            });
            if (event.phase === "end" && matches(event.row, filtersRef.current))
              setHistory((current) =>
                current.some((row) => row.id === event.id) ? current : [event.row, ...current],
              );
          }
        },
        daemon: (state) => {
          daemonState = state;
        },
        close: () => {
          if (disposed) return;
          if (socketRef.current === socket) socketRef.current = null;
          setLink(daemonState ?? "connecting");
          setRunning(new Map());
          const delay = RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)];
          retry = window.setTimeout(connect, delay);
        },
      });
      socketRef.current = socket;
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [url]);

  // Reloads the first page for each connection and each filter change. A response that arrives
  // after a newer reload started is dropped, so pages never mix filters.
  const reloadToken = useRef(0);
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || generation === 0) return;
    const token = ++reloadToken.current;
    setLoadingHistory(true);
    socket
      .request("log.query", JSON.parse(filterKey))
      .then((value) => {
        if (token !== reloadToken.current) return;
        const parsed = actionsResultSchema.safeParse(value);
        if (!parsed.success) return;
        setHistory(parsed.data.rows.filter((row) => row.endedAt !== null));
        setHasMore(parsed.data.hasMore);
      })
      .catch(() => {})
      .finally(() => {
        if (token === reloadToken.current) setLoadingHistory(false);
      });
  }, [generation, filterKey]);

  const loadMore = useCallback(() => {
    const socket = socketRef.current;
    const oldest = history.at(-1);
    if (!socket || !oldest || loadingHistory) return;
    const token = reloadToken.current;
    setLoadingHistory(true);
    socket
      .request("log.query", actionQuery(filtersRef.current, oldest.id))
      .then((value) => {
        if (token !== reloadToken.current) return;
        const parsed = actionsResultSchema.safeParse(value);
        if (!parsed.success) return;
        setHistory((current) => [
          ...current,
          ...parsed.data.rows.filter((row) => row.endedAt !== null),
        ]);
        setHasMore(parsed.data.hasMore);
      })
      .catch(() => {})
      .finally(() => {
        if (token === reloadToken.current) setLoadingHistory(false);
      });
  }, [history, loadingHistory]);

  return {
    link,
    status,
    running: [...running.values()].sort((a, b) => a.startedAt - b.startedAt),
    history,
    hasMore,
    loadingHistory: loadingHistory && link === "open",
    loadMore,
  };
}
