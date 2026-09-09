import { useCallback, useSyncExternalStore } from "react";

export type WidgetType = "chat" | "desktop" | "projects" | "app";

export interface WidgetPlacement {
  id: string;
  type: WidgetType;
  targetId?: string;
  order: number;
  // Optional in-app route and flat scalar params for an `app` widget. `route`
  // rides the iframe src path (`/full/apps/<id>/<route>`), `params` the query
  // (`?k=v`); both persist with the layout so the addressed screen survives
  // reload. Set by an agent's `show_app`/`place_widget`.
  route?: string;
  params?: Record<string, string | number | boolean>;
  // Selected file for a `projects` widget — the file the user (or an agent
  // link) last opened. Persists with the layout so the addressed file survives
  // reload; the embedded file browser disables its own URL-as-SSOT sync, so
  // without this the selection is lost on refresh. A `projects/`-rooted logical
  // path, matching the browser's own selection space.
  selectedPath?: string;
}

export type WidgetSeed =
  | {
      type: "app";
      appId: string;
      route?: string;
      params?: Record<string, string | number | boolean>;
    }
  | {
      type: "projects";
      selectedPath?: string;
    }
  | {
      type: "desktop";
    };

const STORAGE_PREFIX = "rome:free-layout:";
export const STRIP_ITEM_MIN_WIDTH = 320;

let listeners: Array<() => void> = [];
let snapshot: WidgetPlacement[] = [];
let activeSessionId: string | null = null;
const layoutRevisions = new Map<string | null, number>();

export interface ToolView {
  activeId: string | null;
  collapsed: boolean;
  unreadIds: string[];
}

let toolView: ToolView = { activeId: null, collapsed: true, unreadIds: [] };
const VIEW_PREFIX = "rome:tool-view:";

function readToolView(sessionId: string | null, layout: WidgetPlacement[]): ToolView {
  const fallback: ToolView = {
    activeId: [...layout].sort((a, b) => a.order - b.order)[0]?.id ?? null,
    collapsed: layout.length === 0,
    unreadIds: [],
  };
  if (!sessionId) return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(`${VIEW_PREFIX}${sessionId}`) ?? "null");
    if (!saved || typeof saved.collapsed !== "boolean") return fallback;
    return {
      activeId: layout.some((p) => p.id === saved.activeId) ? saved.activeId : fallback.activeId,
      collapsed: saved.collapsed,
      unreadIds: Array.isArray(saved.unreadIds)
        ? layout.filter((p) => saved.unreadIds.includes(p.id)).map((p) => p.id)
        : [],
    };
  } catch {
    return fallback;
  }
}

function saveToolView(next: ToolView) {
  toolView = next;
  if (activeSessionId) {
    try {
      localStorage.setItem(`${VIEW_PREFIX}${activeSessionId}`, JSON.stringify(next));
    } catch {}
  }
}

export function selectTool(id: string) {
  if (!snapshot.some((p) => p.id === id)) return;
  saveToolView({
    activeId: id,
    collapsed: false,
    unreadIds: toolView.unreadIds.filter((x) => x !== id),
  });
  notify();
}

export function setToolsCollapsed(collapsed: boolean) {
  if (!collapsed && toolView.activeId) {
    selectTool(toolView.activeId);
    return;
  }
  saveToolView({ ...toolView, collapsed });
  notify();
}

function reconcileToolView(next: WidgetPlacement[]) {
  const sorted = [...next].sort((a, b) => a.order - b.order);
  const old = [...snapshot].sort((a, b) => a.order - b.order);
  const oldActive = old.find((p) => p.id === toolView.activeId);
  // App navigation replaces its mount id. Keep that tab selected by matching
  // its identity and position, including layouts with duplicate app views.
  const replacement =
    oldActive &&
    sorted.find(
      (p) =>
        p.type === oldActive.type &&
        p.targetId === oldActive.targetId &&
        p.order === oldActive.order,
    );
  const activeId =
    sorted.find((p) => p.id === toolView.activeId)?.id ??
    replacement?.id ??
    sorted[
      Math.min(
        Math.max(
          0,
          old.findIndex((p) => p.id === toolView.activeId),
        ),
        sorted.length - 1,
      )
    ]?.id ??
    null;
  const unread = new Set(toolView.unreadIds);
  for (const p of next) {
    if (!snapshot.some((previous) => previous.id === p.id)) unread.add(p.id);
  }
  saveToolView({
    activeId,
    collapsed: toolView.collapsed,
    unreadIds: next
      .filter((p) => unread.has(p.id) && (toolView.collapsed || p.id !== activeId))
      .map((p) => p.id),
  });
}

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function readStorage(sessionId: string | null): WidgetPlacement[] {
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStorage(sessionId: string | null, layout: WidgetPlacement[]) {
  if (!sessionId) return;
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(layout));
  } catch {}
}

function notify() {
  for (const l of listeners) l();
}

function persist(next: WidgetPlacement[]) {
  layoutRevisions.set(activeSessionId, (layoutRevisions.get(activeSessionId) ?? 0) + 1);
  reconcileToolView(next);
  snapshot = next;
  writeStorage(activeSessionId, next);
  notify();
  if (activeSessionId) {
    void fetch(`/api/chat/sessions/${encodeURIComponent(activeSessionId)}/layout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      // `keepalive` only for teardown-time flushes (document hidden /
      // unloading), where a normal fetch would be cancelled with the page.
      // Interactive saves stay plain fetches so they aren't subject to
      // keepalive's 64 KB cross-request body cap.
      keepalive: typeof document !== "undefined" && document.visibilityState === "hidden",
      body: JSON.stringify({ layout: next }),
    }).catch(() => {});
  }
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot() {
  return snapshot;
}

let idCounter = 0;
function genId(): string {
  return `w${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

function nextOrder(placements: WidgetPlacement[]): number {
  return placements.reduce((max, p) => Math.max(max, p.order), 0) + 1;
}

export function autoPlaceProjects(activate = false): string | null {
  const current = getSnapshot();
  const existing = current.find((p) => p.type === "projects");
  if (existing) {
    if (activate) selectTool(existing.id);
    return existing.id;
  }

  const id = genId();
  persist([...current, { id, type: "projects", order: nextOrder(current) }]);
  if (activate) selectTool(id);
  return id;
}

/**
 * Place a chat card pinned to one session (the side-chat surface). Re-placing
 * the same session is a no-op that keeps the existing placement id — a fresh
 * id would remount the card and tear down its live stream.
 */
export function placeChatWidget(sessionId: string): string {
  const current = getSnapshot();
  const existing = current.find((p) => p.type === "chat" && p.targetId === sessionId);
  if (existing) {
    selectTool(existing.id);
    return existing.id;
  }

  const id = genId();
  persist([...current, { id, type: "chat", targetId: sessionId, order: nextOrder(current) }]);
  selectTool(id);
  return id;
}

export function autoPlaceApp(
  appId: string,
  route?: string,
  params?: Record<string, string | number | boolean>,
  activate = false,
): string {
  let current = getSnapshot();

  // One tile per app. A repeat call retargets the existing tile to the new
  // route/params rather than stacking a duplicate: keep its grid position
  // (`order`) so it doesn't jump, but mint a fresh id so the iframe remounts
  // at the new src.
  const existing = current.find((p) => p.type === "app" && p.targetId === appId);
  if (existing && activate && route === undefined && params === undefined) {
    selectTool(existing.id);
    return existing.id;
  }
  const order = existing ? existing.order : nextOrder(current);
  if (existing) {
    current = current.filter((p) => p.id !== existing.id);
  }

  const id = genId();
  persist([
    ...current,
    {
      id,
      type: "app",
      targetId: appId,
      order,
      ...(route !== undefined ? { route } : {}),
      ...(params !== undefined ? { params } : {}),
    },
  ]);
  if (activate) selectTool(id);
  return id;
}

export function placeWidgets(widgets: readonly WidgetSeed[]): void {
  if (widgets.length === 0) return;

  let current = getSnapshot();
  let changed = false;

  for (const widget of widgets) {
    if (widget.type === "app") {
      if (!widget.appId) continue;
      const existing = current.find((p) => p.type === "app" && p.targetId === widget.appId);
      const order = existing ? existing.order : nextOrder(current);
      if (existing) current = current.filter((p) => p.id !== existing.id);
      current = [
        ...current,
        {
          id: genId(),
          type: "app",
          targetId: widget.appId,
          order,
          ...(widget.route !== undefined ? { route: widget.route } : {}),
          ...(widget.params !== undefined ? { params: widget.params } : {}),
        },
      ];
      changed = true;
      continue;
    }

    if (widget.type === "projects") {
      const existing = current.find((p) => p.type === "projects");
      if (existing) {
        current = current.map((p) => {
          if (p.id !== existing.id) return p;
          const updated: WidgetPlacement = { ...p };
          if (widget.selectedPath !== undefined) updated.selectedPath = widget.selectedPath;
          return updated;
        });
      } else {
        current = [
          ...current,
          {
            id: genId(),
            type: "projects",
            order: nextOrder(current),
            ...(widget.selectedPath !== undefined ? { selectedPath: widget.selectedPath } : {}),
          },
        ];
      }
      changed = true;
      continue;
    }

    if (widget.type === "desktop") {
      if (!current.some((p) => p.type === "desktop")) {
        current = [...current, { id: genId(), type: "desktop", order: nextOrder(current) }];
        changed = true;
      }
    }
  }

  if (changed) persist(current);
}

export function placeWidgetsIfSessionActive(
  sessionId: string | null,
  widgets: readonly WidgetSeed[],
): boolean {
  if (activeSessionId !== sessionId) return false;
  placeWidgets(widgets);
  const last = widgets[widgets.length - 1];
  const placed =
    last &&
    snapshot.find(
      (p) => p.type === last.type && (last.type !== "app" || p.targetId === last.appId),
    );
  if (placed) selectTool(placed.id);
  return true;
}

function paramsEqual(
  a: Record<string, string | number | boolean> | undefined,
  b: Record<string, string | number | boolean> | undefined,
): boolean {
  const x = a ?? {};
  const y = b ?? {};
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  // Compare by string form: a roundtrip through the URL turns the agent's
  // numeric/boolean params into strings, and we don't want that to read as a
  // change and churn a persist.
  return keys.every((k) => k in y && String(x[k]) === String(y[k]));
}

/**
 * Capture a user's in-app navigation back onto an existing `app` placement so
 * the addressed screen survives reload. Updates `route`/`params` **in place** —
 * the placement id is unchanged, so the live iframe is never remounted (only
 * `autoPlaceApp`'s agent-driven retarget mints a fresh id, and AppWidget freezes
 * its `src` at mount). No-ops when the link is unchanged, to avoid pointless
 * localStorage writes and server PUTs.
 */
export function updatePlacementLink(
  placementId: string,
  route: string | undefined,
  params: Record<string, string | number | boolean> | undefined,
): void {
  const current = getSnapshot();
  const target = current.find((p) => p.id === placementId);
  if (!target || target.type !== "app") return;
  const nextParams = params && Object.keys(params).length > 0 ? params : undefined;
  if (
    (target.route ?? undefined) === (route ?? undefined) &&
    paramsEqual(target.params, nextParams)
  ) {
    return;
  }
  persist(
    current.map((p) => {
      if (p.id !== placementId) return p;
      const next: WidgetPlacement = { ...p };
      if (route !== undefined) next.route = route;
      else delete next.route;
      if (nextParams) next.params = nextParams;
      else delete next.params;
      return next;
    }),
  );
}

/**
 * Persist a `projects` tile's currently-selected file back onto its placement
 * so the addressed file survives reload. In place (id unchanged → no remount);
 * no-ops when unchanged to avoid churning localStorage + the server PUT on every
 * click.
 */
export function updateProjectsSelection(placementId: string, selectedPath: string | null): void {
  const current = getSnapshot();
  const target = current.find((p) => p.id === placementId);
  if (!target || target.type !== "projects") return;
  const next = selectedPath ?? undefined;
  if ((target.selectedPath ?? undefined) === next) return;
  persist(
    current.map((p) => {
      if (p.id !== placementId) return p;
      const updated: WidgetPlacement = { ...p };
      if (next) updated.selectedPath = next;
      else delete updated.selectedPath;
      return updated;
    }),
  );
}

export function reorderPlacements(
  placements: WidgetPlacement[],
  activeId: string,
  overId: string,
): WidgetPlacement[] | null {
  const sorted = [...placements].sort((a, b) => a.order - b.order);
  const oldIndex = sorted.findIndex((p) => p.id === activeId);
  const newIndex = sorted.findIndex((p) => p.id === overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return null;

  const [moved] = sorted.splice(oldIndex, 1);
  sorted.splice(newIndex, 0, moved);

  return sorted.map((p, i) => ({ ...p, order: i + 1 }));
}

export function setActiveSession(sessionId: string | null) {
  if (activeSessionId === sessionId) return;
  const previousSessionId = activeSessionId;
  // Carry over draft-mode layout when the user moves from "no session" to
  // a freshly created one. The widgets they placed before hitting send
  // are part of the session they just kicked off — losing them and then
  // partially restoring via the agent's first tool call (which races
  // localStorage) is the bug users see as "Projects auto-closes and
  // reopens a second later" after sending the first message.
  const draftCarryover =
    previousSessionId === null &&
    sessionId !== null &&
    snapshot.length > 0 &&
    readStorage(sessionId).length === 0
      ? snapshot
      : null;

  activeSessionId = sessionId;
  if (draftCarryover) {
    // Reuse `persist` so the layout lands in localStorage and is PUT to
    // the server alongside the notify, keeping the new session's stored
    // layout in sync from the start.
    persist(draftCarryover);
    return;
  }
  snapshot = readStorage(sessionId);
  toolView = readToolView(sessionId, snapshot);
  notify();
}

export async function loadLayoutForSession(sessionId: string): Promise<void> {
  const revision = layoutRevisions.get(sessionId);
  try {
    const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/layout`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { layout?: unknown };
    if (!Array.isArray(data.layout)) return;
    const layout = data.layout as WidgetPlacement[];
    // A delayed load must not erase tools opened or closed since it started.
    if (layoutRevisions.get(sessionId) !== revision) return;
    writeStorage(sessionId, layout);
    if (sessionId === activeSessionId) {
      snapshot = layout;
      toolView = readToolView(sessionId, layout);
      notify();
    }
  } catch {
    // network failed; keep localStorage cache
  }
}

export function useFreeCells() {
  const placements = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const view = useSyncExternalStore(subscribe, getToolView, getToolView);

  const addWidget = useCallback((type: WidgetType, targetId?: string) => {
    const current = getSnapshot();
    const existing = current.find((p) => p.type === type && p.targetId === targetId);
    if (existing) {
      selectTool(existing.id);
      return;
    }
    const id = genId();
    persist([...current, { id, type, targetId, order: nextOrder(current) }]);
    selectTool(id);
  }, []);

  const removeWidget = useCallback((id: string) => {
    persist(getSnapshot().filter((p) => p.id !== id));
  }, []);

  const moveWidget = useCallback((activeId: string, overId: string) => {
    const current = getSnapshot();
    const result = reorderPlacements(current, activeId, overId);
    if (result) persist(result);
  }, []);

  return {
    placements,
    addWidget,
    removeWidget,
    moveWidget,
    toolView: view,
    selectTool,
    setToolsCollapsed,
  };
}

function getToolView() {
  return toolView;
}
