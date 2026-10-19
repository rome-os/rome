// State of a rome-node daemon, read over a console socket that carries the daemon's JSON-RPC
// unchanged. Wire contract: ./protocol.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resultOf } from "./format.js";
import {
  nodeActionRowSchema,
  nodeConsoleDaemonStateSchema,
  nodeEventSchema,
  nodeLogResultSchema,
  nodeStatsSchema,
  nodeStatusSchema,
  type NodeActionQuery,
  type NodeActionResult,
  type NodeActionRow,
  type NodeConsoleDaemonState,
  type NodeStats,
  type NodeStatsQuery,
  type NodeStatus,
} from "./protocol.js";

const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 15_000];
/** Live actions refresh the counts at most this often. */
const STATS_REFRESH_MS = 5000;

type NodeLink = "connecting" | "open" | NodeConsoleDaemonState;

type ActionListener = (phase: "start" | "end", row: NodeActionRow) => void;

export interface NodeSocket {
  link: NodeLink;
  status: NodeStatus | null;
  /** Running actions, oldest first. */
  running: NodeActionRow[];
  /** Counts subscribed connections. Each new one means a gap to refill. */
  generation: number;
  request(method: string, params: unknown): Promise<unknown>;
  onAction(listener: ActionListener): () => void;
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
      else {
        const error = value.error as { code?: unknown; message?: unknown } | undefined;
        pending.reject(Object.assign(new Error(String(error?.message)), { code: error?.code }));
      }
    };
    this.socket.onclose = () => {
      this.rejectAll();
      handlers.close();
    };
  }

  private rejectAll() {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("closed"));
    }
    this.pending.clear();
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
    this.rejectAll();
  }
}

/**
 * Follows the daemon behind `url` while mounted. A new `url` opens a new socket. The socket
 * reconnects with backoff, and each subscribed connection bumps `generation`, so the data hooks
 * reload what the disconnect may have missed.
 */
export function useNodeSocket(url: string): NodeSocket {
  const [link, setLink] = useState<NodeLink>("connecting");
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [running, setRunning] = useState<Map<number, NodeActionRow>>(new Map());
  const [generation, setGeneration] = useState(0);
  const socketRef = useRef<ConsoleSocket | null>(null);
  const listeners = useRef(new Set<ActionListener>());

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
            for (const listener of listeners.current) listener(event.phase, event.row);
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

  const request = useCallback(
    (method: string, params: unknown) =>
      socketRef.current?.request(method, params) ?? Promise.reject(new Error("closed")),
    [],
  );
  const onAction = useCallback((listener: ActionListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const runningList = useMemo(
    () => [...running.values()].sort((a, b) => a.startedAt - b.startedAt),
    [running],
  );
  return { link, status, running: runningList, generation, request, onAction };
}

export interface ActionFilters {
  peer?: string;
  result?: NodeActionResult;
  since?: number;
  until?: number;
  /** Ignored below three characters, the daemon's minimum. */
  text?: string;
}

export function activeTextFilter(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed && [...trimmed].length >= 3 ? trimmed : undefined;
}

function matches(row: NodeActionRow, filters: ActionFilters): boolean {
  if (filters.peer && row.peer?.toLowerCase() !== filters.peer.toLowerCase()) return false;
  if (filters.result && resultOf(row) !== filters.result) return false;
  if (filters.since !== undefined && row.startedAt < filters.since) return false;
  if (filters.until !== undefined && row.startedAt >= filters.until) return false;
  // Substring matching belongs to the daemon's index, so a text filter shows only fetched rows.
  return !activeTextFilter(filters.text);
}

function actionQuery(filters: ActionFilters, limit: number, before?: number): NodeActionQuery {
  const text = activeTextFilter(filters.text);
  return {
    kind: "actions",
    limit,
    ...(before === undefined ? {} : { before }),
    ...(filters.peer ? { peer: filters.peer } : {}),
    ...(filters.result ? { result: [filters.result] } : {}),
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
    ...(text ? { text } : {}),
  };
}

const actionsResultSchema = nodeLogResultSchema(nodeActionRowSchema);

export interface ActionList {
  rows: NodeActionRow[];
  hasMore: boolean;
  loading: boolean;
  loadMore(): void;
}

/**
 * Actions that match `filters`, newest first, in pages of `pageSize`. Live actions join at the
 * top and update in place, and an action that stops matching, such as a running one that ends,
 * leaves the list. The list keeps at most `max` rows.
 */
export function useActions(
  socket: NodeSocket,
  filters: ActionFilters,
  pageSize = 50,
  max = Number.POSITIVE_INFINITY,
): ActionList {
  const [rows, setRows] = useState<NodeActionRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const key = JSON.stringify(actionQuery(filters, pageSize));
  const { generation, request, onAction } = socket;

  useEffect(
    () =>
      onAction((_phase, row) => {
        const fits = matches(row, filtersRef.current);
        setRows((current) => {
          const index = current.findIndex((item) => item.id === row.id);
          if (index >= 0)
            return fits
              ? current.map((item) => (item.id === row.id ? row : item))
              : current.filter((item) => item.id !== row.id);
          return fits ? [row, ...current].slice(0, max) : current;
        });
      }),
    [onAction, max],
  );

  // Reloads the first page for each connection and each filter change. A response that arrives
  // after a newer reload started is dropped, so pages never mix filters.
  const token = useRef(0);
  useEffect(() => {
    if (generation === 0) return;
    const current = ++token.current;
    setLoading(true);
    request("log.query", JSON.parse(key))
      .then((value) => {
        if (current !== token.current) return;
        const parsed = actionsResultSchema.safeParse(value);
        if (!parsed.success) return;
        setRows(parsed.data.rows);
        setHasMore(parsed.data.hasMore);
      })
      .catch(() => {})
      .finally(() => {
        if (current === token.current) setLoading(false);
      });
  }, [generation, key, request]);

  const loadMore = useCallback(() => {
    const oldest = rows.at(-1);
    if (!oldest || loading) return;
    const current = token.current;
    setLoading(true);
    request("log.query", actionQuery(filtersRef.current, pageSize, oldest.id))
      .then((value) => {
        if (current !== token.current) return;
        const parsed = actionsResultSchema.safeParse(value);
        if (!parsed.success) return;
        setRows((existing) => {
          const seen = new Set(existing.map((row) => row.id));
          return [...existing, ...parsed.data.rows.filter((row) => !seen.has(row.id))];
        });
        setHasMore(parsed.data.hasMore);
      })
      .catch(() => {})
      .finally(() => {
        if (current === token.current) setLoading(false);
      });
  }, [rows, loading, request, pageSize]);

  return { rows, hasMore, loading: loading && socket.link === "open", loadMore };
}

/** One action by id, for a link that names an action outside the loaded pages. */
export function useAction(socket: NodeSocket, id: number | null, peer?: string) {
  const [row, setRow] = useState<NodeActionRow | null>(null);
  const { generation, request, onAction } = socket;
  useEffect(() => {
    setRow(null);
    if (id === null || generation === 0) return;
    let live = true;
    request("log.query", { kind: "actions", before: id + 1, limit: 1, ...(peer ? { peer } : {}) })
      .then((value) => {
        const parsed = actionsResultSchema.safeParse(value);
        const found = parsed.success ? parsed.data.rows[0] : undefined;
        if (live && found?.id === id) setRow(found);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, peer, generation, request]);
  useEffect(
    () =>
      onAction((_phase, next) => {
        if (next.id === id) setRow(next);
      }),
    [onAction, id],
  );
  return row;
}

export interface StatsState {
  stats: NodeStats | null;
  /** False when the daemon predates `log.stats`. */
  supported: boolean;
}

/**
 * Counts for `query`, reloaded for each connection and each query change, and refreshed while
 * actions run. `query.since` moves with the clock, so callers round it to a bucket.
 */
export function useStats(socket: NodeSocket, query: NodeStatsQuery): StatsState {
  const [state, setState] = useState<StatsState>({ stats: null, supported: true });
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(query);
  const { generation, request, onAction } = socket;

  useEffect(() => {
    let timer: number | undefined;
    const off = onAction(() => {
      timer ??= window.setTimeout(() => {
        timer = undefined;
        setTick((value) => value + 1);
      }, STATS_REFRESH_MS);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [onAction]);

  useEffect(() => {
    if (generation === 0) return;
    let live = true;
    request("log.stats", JSON.parse(key))
      .then((value) => {
        const parsed = nodeStatsSchema.safeParse(value);
        if (live && parsed.success) setState({ stats: parsed.data, supported: true });
      })
      .catch((error: { code?: unknown }) => {
        if (live && error?.code === -32601) setState({ stats: null, supported: false });
      });
    return () => {
      live = false;
    };
  }, [generation, key, request, tick]);

  return state;
}
