// Per-turn workspace context. Session model: docs/concepts/sessions.md.
//
// The chat agent receives a per-turn `<workspace-context>` block describing
// what the user is currently seeing alongside the chat. Two data shapes:
//
//   - **Built-ins** (projects, desktop) live inside the shell. Each widget
//     pushes its current snapshot into this registry on state change.
//     Subscribers see those changes immediately — no polling.
//
//   - **Installed apps** are iframes the shell cannot reach into. Each
//     `AppWidget` registers its iframe ref here on mount; the URL is
//     resolved only at turn-send time by `collect()`, so the agent always
//     gets the moment-of-send truth (even if the iframe navigates between
//     "send" being shown to the user and the request hitting the wire).
//
// The chip row above the composer subscribes for visibility cues; the
// send sites in `Chat` / `ChatComponent` call `collect()` once per turn.

import { createContext, useContext } from "react";

export type WorkspaceContextBuiltin =
  | {
      kind: "projects";
      /** Project name if a session has been created. Missing on first turn. */
      project?: string;
      files: Array<{ path: string; focused?: boolean }>;
    }
  | { kind: "desktop"; line: string };

export interface WorkspaceContextSnapshot {
  builtins: WorkspaceContextBuiltin[];
  apps: Array<{ appId: string; url: string }>;
}

// Size and safety budget for context passed into a turn.
export const WORKSPACE_CONTEXT_LIMITS = {
  /** Combined cap across builtins + apps in a single snapshot. */
  maxEntries: 8,
  /** Per-projects cap on the file list. */
  maxFilesPerProject: 10,
  /** Per-line char cap for builtin strings (paths, status lines). */
  maxLineChars: 200,
  /** Per-URL char cap for app entries. */
  maxUrlChars: 2000,
} as const;

function trunc(value: string, max: number): string {
  return value.length > max ? value.slice(0, Math.max(0, max - 1)) + "…" : value;
}

// Registry

interface AppEntry {
  appId: string;
  iframe: HTMLIFrameElement | null;
}

export interface WorkspaceContextRegistry {
  /** Builtin push API. `null` clears the slot. */
  setBuiltin(slotId: string, snapshot: WorkspaceContextBuiltin | null): void;
  getBuiltins(): WorkspaceContextBuiltin[];

  /** App iframe registration. Pass `null` for `iframe` to unregister. */
  registerApp(placementId: string, appId: string, iframe: HTMLIFrameElement | null): void;
  /** `appId`s in registration order. URLs are NOT resolved here. */
  listApps(): Array<{ placementId: string; appId: string }>;

  /**
   * Resolve a placement's live in-app link by reading its iframe's current
   * location. Strips the host route prefix (`/full/apps/<appId>`), leaving the
   * app's own route + its entire query — host context (session, interaction)
   * never lands in the URL, so the query is wholly the app's to keep.
   * Returns `null` when the iframe is gone or cross-origin (unreadable) —
   * callers keep the previously-stored link then.
   */
  resolveLink(placementId: string): { route?: string; params?: Record<string, string> } | null;

  /** One subscription covers both builtin and app changes. */
  subscribe(listener: () => void): () => void;
  /** Monotonic version stamp — use as the `useSyncExternalStore` snapshot. */
  getVersion(): number;

  /** Resolve a turn-time snapshot. Reads iframe URLs at call time. */
  collect(): WorkspaceContextSnapshot;
}

export function createWorkspaceContextRegistry(): WorkspaceContextRegistry {
  const builtins = new Map<string, WorkspaceContextBuiltin>();
  const apps = new Map<string, AppEntry>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = () => {
    version++;
    for (const l of listeners) l();
  };

  return {
    setBuiltin(slotId, snapshot) {
      if (snapshot === null) {
        if (!builtins.delete(slotId)) return;
      } else {
        builtins.set(slotId, snapshot);
      }
      notify();
    },
    getBuiltins() {
      return [...builtins.values()];
    },
    registerApp(placementId, appId, iframe) {
      if (iframe === null) {
        if (!apps.delete(placementId)) return;
      } else {
        apps.set(placementId, { appId, iframe });
      }
      notify();
    },
    listApps() {
      return [...apps.entries()].map(([placementId, entry]) => ({
        placementId,
        appId: entry.appId,
      }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    },
    collect() {
      const out: WorkspaceContextSnapshot = { builtins: [], apps: [] };
      let count = 0;

      for (const builtin of builtins.values()) {
        if (count >= WORKSPACE_CONTEXT_LIMITS.maxEntries) break;
        out.builtins.push(builtin);
        count++;
      }

      for (const entry of apps.values()) {
        if (count >= WORKSPACE_CONTEXT_LIMITS.maxEntries) break;
        let url = "";
        try {
          // Same-origin only. Cross-origin throws SecurityError; skip it.
          url = entry.iframe?.contentWindow?.location?.href ?? "";
        } catch {
          url = "";
        }
        if (!url) continue;
        out.apps.push({
          appId: entry.appId,
          url: trunc(url, WORKSPACE_CONTEXT_LIMITS.maxUrlChars),
        });
        count++;
      }

      return out;
    },
    resolveLink(placementId) {
      const entry = apps.get(placementId);
      if (!entry?.iframe) return null;
      let href = "";
      try {
        // Same-origin only. Cross-origin throws SecurityError; bail and let the
        // caller keep the stored link.
        href = entry.iframe.contentWindow?.location?.href ?? "";
      } catch {
        return null;
      }
      if (!href) return null;
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return null;
      }
      // Recover the app's own route from the path after `/full/apps/<appId>`.
      // Mirror the encoding AppWidget applies (per-segment encodeURIComponent),
      // so we hand back the decoded route it can re-encode 1:1.
      const prefix = `/full/apps/${encodeURIComponent(entry.appId)}`;
      // Only capture when the frame is actually within this app's namespace. A
      // transitional `about:blank` (fast reload before the frame loads) or any
      // unrelated URL must resolve to null so the flush keeps the stored link
      // rather than clearing it. `pathname === prefix` is the app root (route
      // legitimately cleared); a trailing segment carries the route.
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
        return null;
      }
      let route: string | undefined;
      if (url.pathname.startsWith(`${prefix}/`)) {
        const decoded = url.pathname
          .slice(prefix.length + 1)
          .split("/")
          .filter(Boolean)
          .map((seg) => {
            try {
              return decodeURIComponent(seg);
            } catch {
              return seg;
            }
          })
          .join("/");
        route = decoded || undefined;
      }
      // The whole query is the app's own. Host context rides the global-params
      // channel, not the URL, so capture the query verbatim.
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) {
        params[k] = v;
      }
      return {
        route,
        params: Object.keys(params).length > 0 ? params : undefined,
      };
    },
  };
}

export const WorkspaceContextRegistryContext = createContext<WorkspaceContextRegistry | null>(null);

export function useWorkspaceContextRegistry(): WorkspaceContextRegistry | null {
  return useContext(WorkspaceContextRegistryContext);
}

/**
 * Invoke `registry.collect()` and return the snapshot — or `null` when the
 * registry is missing or the snapshot is empty. Lets
 * each send site attach workspace context in one expression.
 */
export function snapshotWorkspaceForSend(
  registry: WorkspaceContextRegistry | null,
): WorkspaceContextSnapshot | null {
  if (!registry) return null;
  const snap = registry.collect();
  if (snap.builtins.length === 0 && snap.apps.length === 0) return null;
  return snap;
}

// Builtin authoring helpers — used by widget code that pushes into the
// registry. Wraps the per-builtin truncation rules so each widget doesn't
// reinvent them.

export function buildProjectsBuiltin(input: {
  project: string | null;
  files: Array<{ path: string; focused?: boolean }>;
}): WorkspaceContextBuiltin | null {
  const raw = input.files;
  if (!input.project && raw.length === 0) return null;
  const kept = raw.slice(0, WORKSPACE_CONTEXT_LIMITS.maxFilesPerProject);
  const dropped = Math.max(0, raw.length - kept.length);
  const files = kept.map((f) => ({
    path: trunc(f.path, WORKSPACE_CONTEXT_LIMITS.maxLineChars),
    ...(f.focused ? { focused: true } : {}),
  }));
  if (dropped > 0) files.push({ path: `… (${dropped} more)` });
  const project = input.project
    ? trunc(input.project, WORKSPACE_CONTEXT_LIMITS.maxLineChars)
    : undefined;
  return { kind: "projects", ...(project ? { project } : {}), files };
}
