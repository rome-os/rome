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
  // Selected file or folder for a `projects` widget — wherever the user (or an
  // agent link) last navigated. Persists with the layout so the addressed spot
  // survives reload and rides the open-in-new-tab link; the embedded file
  // browser disables its own URL-as-SSOT sync, so without this the selection is
  // lost on refresh. A `projects/`-rooted logical path, matching the browser's
  // own selection space.
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

// Counts explicit activations: every `selectTool` call, which comes from the
// user opening an app (a tab, a chat link, a navigation handoff). Store-side
// changes such as an agent re-placing a tile or a background tab closing don't
// count, so a view layered over the pane (the Trace tab) can tell them apart.
let activations = 0;

export function selectTool(id: string) {
  if (!snapshot.some((p) => p.id === id)) return;
  activations += 1;
  showTool(id);
}

function showTool(id: string) {
  saveToolView({
    activeId: id,
    collapsed: false,
    unreadIds: toolView.unreadIds.filter((x) => x !== id),
  });
  notify();
}

export function setToolsCollapsed(collapsed: boolean) {
  if (!collapsed && toolView.activeId) {
    if (snapshot.some((p) => p.id === toolView.activeId)) showTool(toolView.activeId);
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
    const previous = snapshot.find((previous) => previous.id === p.id);
    if (!previous || (p.type === "projects" && p.selectedPath !== previous.selectedPath)) {
      unread.add(p.id);
    }
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
  return readStoredLayout(sessionId) ?? [];
}

// Returns null when the session has no stored layout or it does not parse.
function readStoredLayout(sessionId: string): WidgetPlacement[] | null {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storedLayoutJson(sessionId: string): string | null {
  try {
    return localStorage.getItem(storageKey(sessionId));
  } catch {
    return null;
  }
}

function writeStorage(sessionId: string | null, layout: WidgetPlacement[]): boolean {
  if (!sessionId) return false;
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

function notify() {
  for (const l of listeners) l();
}

// Marks a session whose stored layout the server has not acknowledged. Kept in
// localStorage beside the layout so a reload or another tab still treats the
// local copy as newer than the server's.
const UNSYNCED_PREFIX = "rome:free-layout-unsynced:";

function hasUnsyncedLayout(sessionId: string): boolean {
  try {
    return localStorage.getItem(`${UNSYNCED_PREFIX}${sessionId}`) !== null;
  } catch {
    return false;
  }
}

function setUnsyncedLayout(sessionId: string, unsynced: boolean) {
  try {
    if (unsynced) localStorage.setItem(`${UNSYNCED_PREFIX}${sessionId}`, "1");
    else localStorage.removeItem(`${UNSYNCED_PREFIX}${sessionId}`);
  } catch {}
}

// A session's save in flight. `next` holds the newest layout still to send, so
// edits made during a PUT coalesce into one later PUT. `stored` says whether
// `next` reached localStorage.
interface LayoutSave {
  next: WidgetPlacement[] | null;
  stored: boolean;
}

const layoutSaves = new Map<string, LayoutSave>();
const LAYOUT_SAVE_TIMEOUT_MS = 15_000;

// `stored` says whether `layout` reached localStorage. When the write failed,
// for example on a full quota, the stored copy is older than `layout`, so the
// marker is cleared rather than set to keep a later load from resending it.
function saveLayout(sessionId: string, layout: WidgetPlacement[], stored: boolean) {
  setUnsyncedLayout(sessionId, stored);
  const pending = layoutSaves.get(sessionId);
  if (pending) {
    pending.next = layout;
    pending.stored = stored;
    return;
  }
  const save: LayoutSave = { next: layout, stored };
  layoutSaves.set(sessionId, save);
  void drainLayoutSaves(sessionId, save);
}

// Sends one PUT at a time per session, so this tab never sends an older layout
// after a newer one. A timed-out PUT can still land after the next one if the
// server stalls past the timeout and then applies it. When the PUT carrying the
// newest layout succeeds, the unsynced marker clears only if the stored layout
// still matches it. A different stored layout came from another tab, and this
// PUT may have landed after that tab's, so the marker is set to make a later
// load resend it.
async function drainLayoutSaves(sessionId: string, save: LayoutSave) {
  while (save.next) {
    const layout = save.next;
    const stored = save.stored;
    save.next = null;
    let ok = false;
    try {
      const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // `keepalive` only for teardown-time flushes (document hidden /
        // unloading), where a normal fetch would be cancelled with the page.
        // Interactive saves stay plain fetches so they aren't subject to
        // keepalive's 64 KB cross-request body cap. A teardown save queued
        // behind an in-flight PUT is not sent before the page unloads, and its
        // unsynced marker makes the next load send it.
        keepalive: typeof document !== "undefined" && document.visibilityState === "hidden",
        // A PUT that never settles would hold every later save for the session.
        signal: AbortSignal.timeout(LAYOUT_SAVE_TIMEOUT_MS),
        body: JSON.stringify({ layout }),
      });
      ok = res.ok;
    } catch {}
    if (ok && !save.next) {
      // A failed storage write leaves this tab's older layout stored, so it
      // must not be marked for resending.
      if (storedLayoutJson(sessionId) === JSON.stringify(layout)) {
        setUnsyncedLayout(sessionId, false);
      } else if (stored) {
        setUnsyncedLayout(sessionId, true);
      }
    }
  }
  layoutSaves.delete(sessionId);
}

function persist(next: WidgetPlacement[]) {
  layoutRevisions.set(activeSessionId, (layoutRevisions.get(activeSessionId) ?? 0) + 1);
  reconcileToolView(next);
  snapshot = next;
  const stored = writeStorage(activeSessionId, next);
  notify();
  if (activeSessionId) saveLayout(activeSessionId, next, stored);
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
    else if (
      (toolView.collapsed || toolView.activeId !== existing.id) &&
      !toolView.unreadIds.includes(existing.id)
    ) {
      saveToolView({ ...toolView, unreadIds: [...toolView.unreadIds, existing.id] });
      notify();
    }
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

// One tile per app. A repeat placement retargets the existing tile to the new
// route/params rather than stacking a duplicate: keep its grid position
// (`order`) so it doesn't jump, but mint a fresh id so the iframe remounts at
// the new src.
function withAppPlacement(
  placements: WidgetPlacement[],
  seed: Omit<Extract<WidgetSeed, { type: "app" }>, "type">,
): { placements: WidgetPlacement[]; id: string } {
  const existing = placements.find((p) => p.type === "app" && p.targetId === seed.appId);
  const order = existing ? existing.order : nextOrder(placements);
  const kept = existing ? placements.filter((p) => p.id !== existing.id) : placements;
  const id = genId();
  return {
    id,
    placements: [
      ...kept,
      {
        id,
        type: "app",
        targetId: seed.appId,
        order,
        ...(seed.route !== undefined ? { route: seed.route } : {}),
        ...(seed.params !== undefined ? { params: seed.params } : {}),
      },
    ],
  };
}

export function autoPlaceApp(
  appId: string,
  route?: string,
  params?: Record<string, string | number | boolean>,
  activate = false,
): string {
  const next = withAppPlacement(getSnapshot(), { appId, route, params });
  persist(next.placements);
  if (activate) selectTool(next.id);
  return next.id;
}

// Agent placements already applied: the tile each one mounted, keyed by layout
// session and the server's `placementId`. Module scope so the record outlives
// a Chat remount; keyed by layout because a placement applied in one session's
// layout is still missing from another's.
const appliedAgentPlacements = new Map<string, string>();

/**
 * Apply an agent's `widget_placement` to the active layout. A resumed turn
 * stream replays each app's latest placement, and applying it again would
 * remount the widget and drop the guardian's navigation inside it, so a replay
 * is skipped while the tile it mounted is still in the layout. If the tile is
 * gone, for example because a layout load brought in a copy saved on another
 * device, the replay places it again. A placement without an id always
 * applies.
 */
export function applyAgentPlacement(
  placementId: string | undefined,
  appId: string,
  route?: string,
  params?: Record<string, string | number | boolean>,
): void {
  const key = placementId ? JSON.stringify([activeSessionId, placementId]) : null;
  const appliedTileId = key ? appliedAgentPlacements.get(key) : undefined;
  if (appliedTileId && getSnapshot().some((p) => p.id === appliedTileId)) return;
  const tileId = autoPlaceApp(appId, route, params);
  if (key) appliedAgentPlacements.set(key, tileId);
}

export function placeWidgets(widgets: readonly WidgetSeed[]): void {
  if (widgets.length === 0) return;

  let current = getSnapshot();
  let changed = false;

  for (const widget of widgets) {
    if (widget.type === "app") {
      if (!widget.appId) continue;
      current = withAppPlacement(current, widget).placements;
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

/**
 * Place a navigation's widget handoff and make the last one the active tab.
 * `chatFirst` keeps the panel collapsed with that tab marked unread, for
 * layouts that show one pane at a time where expanding would hide the chat.
 */
export function placeWidgetsIfSessionActive(
  sessionId: string | null,
  widgets: readonly WidgetSeed[],
  { chatFirst = false }: { chatFirst?: boolean } = {},
): boolean {
  if (activeSessionId !== sessionId) return false;
  placeWidgets(widgets);
  const last = widgets[widgets.length - 1];
  const placed =
    last &&
    snapshot.find(
      (p) => p.type === last.type && (last.type !== "app" || p.targetId === last.appId),
    );
  if (!placed) return true;
  if (chatFirst) {
    saveToolView({
      activeId: placed.id,
      collapsed: true,
      unreadIds: [...toolView.unreadIds.filter((x) => x !== placed.id), placed.id],
    });
    notify();
  } else {
    selectTool(placed.id);
  }
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
  updatePlacementLinks([{ placementId, route, params }]);
}

export interface PlacementLink {
  placementId: string;
  route: string | undefined;
  params: Record<string, string | number | boolean> | undefined;
}

/**
 * `updatePlacementLink` for several tiles in one save. A teardown flush must
 * use it: only the first PUT of a burst is sent before the page unloads, and
 * later ones wait behind it.
 */
export function updatePlacementLinks(links: PlacementLink[]): void {
  const byId = new Map(links.map((link) => [link.placementId, link]));
  let changed = false;
  const next = getSnapshot().map((p) => {
    const link = byId.get(p.id);
    if (!link || p.type !== "app") return p;
    const { route } = link;
    const nextParams = link.params && Object.keys(link.params).length > 0 ? link.params : undefined;
    if ((p.route ?? undefined) === (route ?? undefined) && paramsEqual(p.params, nextParams)) {
      return p;
    }
    changed = true;
    const updated: WidgetPlacement = { ...p };
    if (route !== undefined) updated.route = route;
    else delete updated.route;
    if (nextParams) updated.params = nextParams;
    else delete updated.params;
    return updated;
  });
  if (changed) persist(next);
}

/**
 * Persist a `projects` tile's currently-selected file or folder back onto its
 * placement so the addressed spot survives reload. In place (id unchanged → no
 * remount); no-ops when unchanged to avoid churning localStorage + the server
 * PUT on every click.
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

/**
 * Replace the session's cached layout with the server's copy. When the server
 * has not acknowledged the cached layout, keep it and send it again instead,
 * so a failed save is retried rather than lost. Never rejects.
 */
export async function loadLayoutForSession(sessionId: string): Promise<void> {
  if (hasUnsyncedLayout(sessionId)) {
    // A save still in flight already carries the newest layout.
    if (layoutSaves.has(sessionId)) return;
    const stored = readStoredLayout(sessionId);
    if (stored) {
      saveLayout(sessionId, stored, true);
      return;
    }
    // With no readable stored layout there is nothing to resend, and sending an
    // empty layout would erase the server's copy.
    setUnsyncedLayout(sessionId, false);
  }
  const revision = layoutRevisions.get(sessionId);
  try {
    const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/layout`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { layout?: unknown };
    if (!Array.isArray(data.layout)) return;
    const layout = data.layout as WidgetPlacement[];
    // A delayed load must not erase tools opened or closed since it started,
    // or an edit another tab stored that the server has not acknowledged.
    if (layoutRevisions.get(sessionId) !== revision || hasUnsyncedLayout(sessionId)) return;
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
  const toolActivations = useSyncExternalStore(subscribe, getActivations, getActivations);

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

  return {
    placements,
    addWidget,
    removeWidget,
    toolView: view,
    toolActivations,
    selectTool,
    setToolsCollapsed,
  };
}

function getToolView() {
  return toolView;
}

function getActivations() {
  return activations;
}
