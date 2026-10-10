import { useSyncExternalStore } from "react";

/** Structurally compatible with the opaque session reference emitted by
 * `@rome-os/app-runtime`. Keep this browser SDK declaration in sync with the
 * runtime SDK without introducing a package dependency between the two SDKs. */
export type RomeSessionType =
  | "webchat"
  | "webchat_handoff"
  | "channel"
  | "action"
  | "fork"
  | "subagent";

/** Opaque reference to a durable Rome session. Pass this object through
 * unchanged; do not inspect or construct its fields in app code. */
export interface RomeSessionRef {
  readonly _romeSessionId: string;
  readonly _type: RomeSessionType;
}

export type RomeAppTheme = "light" | "dark";
export type RomeAppThemeName = string;
export type RomeAppShellMode = "embedded" | "full" | "preview";

/**
 * Host-injected runtime context for this app surface. Deliberately NOT carried
 * on the app's URL query — the query string is the app's own namespace (an app
 * may define its own `?session=` with its own meaning), and the host never
 * reserves keys in it. The host delivers these out-of-band instead: via
 * postMessage for iframe mounts (after a `ready` handshake, re-sent on change),
 * or seeded into `bootstrap.globalParams` for same-window mounts.
 *
 * Treat the values as live: for an iframe mount the session arrives (and can
 * change) shortly after mount, so read them through `getGlobalParams()` /
 * `getChatSessionId()` and react via `subscribeGlobalParams()` or the React
 * hooks — never assume they are present on first paint.
 */
export interface RomeAppGlobalParams {
  /**
   * The chat session this surface is bound to, or absent when unbound / not yet
   * delivered. This is the *host's* session — distinct from any `?session=`
   * query param an app defines for its own purposes.
   */
  chatSessionId?: string;
  /** True when mounted as a suspendable-action interaction surface. */
  interaction?: boolean;
}

/**
 * Who is looking at this app surface, resolved by the host when it served the
 * bootstrap (never from anything the client claims about itself):
 *
 * - `guardian` — the instance owner, signed into the dashboard.
 * - `visitor` — a verified Rome Cloud visitor (cloud-email access tier).
 * - `anonymous` — anyone else on a public app surface.
 *
 * **Advisory, for UI gating only** — show or hide owner-only affordances with
 * it, but never treat it as enforcement: any client can run arbitrary code, so
 * every owner-only API route must check `request.caller` in the app's API
 * handler (`@rome-os/app-runtime`) server-side.
 *
 * Delivered on the bootstrap (not `globalParams`) because it is fixed per
 * mount: identity changes only through a full-page login redirect, which
 * remounts the app.
 */
export type RomeAppCaller =
  | { kind: "guardian"; userId: string }
  | { kind: "visitor"; accountId: string; email: string }
  | { kind: "anonymous" };

export interface RomeAppBootstrap {
  appId: string;
  version: string;
  routeBase: string;
  routePath: string;
  apiBase: string;
  assetBase: string;
  shell: {
    locale: string;
    theme: RomeAppTheme;
    themeName: RomeAppThemeName;
    mode: RomeAppShellMode;
  };
  /** Host-resolved caller identity for this mount — see {@link RomeAppCaller}. */
  caller?: RomeAppCaller;
  /** Host runtime context (chat session, interaction flag). May be empty or
   *  arrive after mount — see {@link RomeAppGlobalParams}. */
  globalParams?: RomeAppGlobalParams;
}

declare global {
  interface Window {
    __ROME_APP_BOOTSTRAP__?: RomeAppBootstrap;
  }
}

const NAVIGATION_EVENT = "rome:app:navigation";

let mountContainer: HTMLElement | null = null;

/**
 * Records the app's Shadow DOM mount node so portaled UI remains inside the
 * app's styling boundary. `null` clears it on unmount.
 */
export function setMountContainer(node: HTMLElement | null): void {
  mountContainer = node;
  if (node) installPortalEscapeGuard();
  else uninstallPortalEscapeGuard();
}

/**
 * The node portal-based components must render into to keep the app's styles:
 * the app's mount node, which lives inside its Shadow DOM. Returns `undefined`
 * before mount (tests/SSR), where the portal library's document.body default
 * is correct.
 */
export function getPortalContainer(): HTMLElement | undefined {
  return mountContainer ?? undefined;
}

const FLOATING_ROLES =
  "[role=dialog],[role=alertdialog],[role=tooltip],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]";

/** Rome's local dev stack serves apps from `*.localhost`; production guardian
 *  deployments use real domains. The guard is a developer aid, so confine it to
 *  dev hosts and keep production consoles clean. */
function isDevHost(): boolean {
  if (typeof location === "undefined") return false;
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
}

let escapeObserver: MutationObserver | null = null;

/**
 * Dev-only safety net: warns when a floating layer is appended to document.body
 * instead of the app's Shadow DOM — the symptom of a portal-based component
 * that forgot `container={getPortalContainer()}`. Turns a silent visual bug
 * (missing styles) into a console warning the moment it happens. Installed on
 * mount and disconnected on unmount, so each mount can warn once.
 */
function installPortalEscapeGuard(): void {
  if (escapeObserver) return;
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  if (!isDevHost()) return;

  let warned = false;
  escapeObserver = new MutationObserver((mutations) => {
    if (warned) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const isFloating = node.matches(FLOATING_ROLES) || !!node.querySelector(FLOATING_ROLES);
        if (!isFloating) continue;
        warned = true;
        console.warn(
          "[rome-app] A pop-up (dialog/popover/tooltip/menu) rendered into document.body " +
            "instead of the app's Shadow DOM, so it is missing the app's styles. Pass " +
            "`container={getPortalContainer()}` (from @rome-os/app-web-sdk) to its Portal. " +
            "If this layer came from the host dashboard rather than the app, ignore.",
        );
        return;
      }
    }
  });
  escapeObserver.observe(document.body, { childList: true });
}

function uninstallPortalEscapeGuard(): void {
  escapeObserver?.disconnect();
  escapeObserver = null;
}

function requireBootstrap(): RomeAppBootstrap {
  if (typeof window === "undefined" || !window.__ROME_APP_BOOTSTRAP__) {
    throw new Error("Rome app bootstrap is not available");
  }
  return window.__ROME_APP_BOOTSTRAP__;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") {
    return "";
  }

  const segments = trimmed
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  return segments.map((segment) => decodeAndValidateSegment(segment, path)).join("/");
}

function decodeAndValidateSegment(segment: string, originalPath: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`Invalid app-relative path "${originalPath}"`);
  }

  if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
    throw new Error(`Invalid app-relative path "${originalPath}"`);
  }

  return decoded;
}

function encodePath(path: string): string {
  if (path === "") {
    return "";
  }

  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function splitPathAndQuery(pathWithQuery: string): { path: string; query: string } {
  const queryStart = pathWithQuery.indexOf("?");
  if (queryStart === -1) {
    return { path: pathWithQuery, query: "" };
  }

  return {
    path: pathWithQuery.slice(0, queryStart),
    query: pathWithQuery.slice(queryStart + 1),
  };
}

function normalizeQuery(query: string, originalPath: string): string {
  if (query === "") {
    return "";
  }

  try {
    return new URLSearchParams(query).toString();
  } catch {
    throw new Error(`Invalid app-relative path "${originalPath}"`);
  }
}

function emitNavigation(path: string): void {
  window.dispatchEvent(
    new CustomEvent<string>(NAVIGATION_EVENT, {
      detail: path,
    }),
  );
}

export function getBootstrap(): RomeAppBootstrap {
  return requireBootstrap();
}

/**
 * True when this app is mounted by a preview host (the Rome App Store's
 * try-in-browser page) rather than a Rome instance. A preview mount has no
 * backend: agents, chat, the app API, and persistence are unavailable —
 * `fetchAppApi()` and `startChat()` fail with 503. Gate backend-dependent
 * affordances on this to degrade gracefully (e.g. disable a "Send to agent"
 * button instead of letting it error).
 *
 * Returns `false` before bootstrap is available (tests/SSR), where assuming a
 * real host is the safe default.
 */
export function isPreview(): boolean {
  if (typeof window === "undefined" || !window.__ROME_APP_BOOTSTRAP__) return false;
  return window.__ROME_APP_BOOTSTRAP__.shell.mode === "preview";
}

export function getCurrentAppPath(): string {
  const bootstrap = requireBootstrap();
  const currentPathname = window.location.pathname;
  if (currentPathname === bootstrap.routeBase) {
    return "";
  }
  if (currentPathname.startsWith(`${bootstrap.routeBase}/`)) {
    return normalizePath(currentPathname.slice(bootstrap.routeBase.length + 1));
  }
  return normalizePath(bootstrap.routePath);
}

export function buildAppUrl(path: string = ""): string {
  return appUrlFor(normalizePath(path));
}

function appUrlFor(normalizedPath: string): string {
  const routeBase = requireBootstrap().routeBase;
  const encodedPath = encodePath(normalizedPath);
  return encodedPath ? `${routeBase}/${encodedPath}` : routeBase;
}

export function navigateToApp(path: string = "", options?: { replace?: boolean }): void {
  // Normalize once: normalizePath decodes each segment, so a second pass would
  // decode "%2520" twice and write a URL that disagrees with the emitted path.
  const normalizedPath = normalizePath(path);
  const url = appUrlFor(normalizedPath);
  if (options?.replace) {
    window.history.replaceState(null, "", url);
  } else {
    window.history.pushState(null, "", url);
  }
  emitNavigation(normalizedPath);
}

export function subscribeToAppPath(listener: (path: string) => void): () => void {
  const handlePopstate = () => listener(getCurrentAppPath());
  const handleNavigate = (event: Event) => {
    listener((event as CustomEvent<string>).detail);
  };

  window.addEventListener("popstate", handlePopstate);
  window.addEventListener(NAVIGATION_EVENT, handleNavigate);

  return () => {
    window.removeEventListener("popstate", handlePopstate);
    window.removeEventListener(NAVIGATION_EVENT, handleNavigate);
  };
}

export function buildAssetUrl(path: string): string {
  const bootstrap = requireBootstrap();
  const normalizedPath = normalizePath(path);
  const encodedPath = encodePath(normalizedPath);
  return encodedPath ? `${bootstrap.assetBase}/${encodedPath}` : bootstrap.assetBase;
}

const INTERACTION_RESOLVE = "rome:interaction:resolve";
const INTERACTION_DISMISS = "rome:interaction:dismiss";

/**
 * True when this app is mounted as a suspendable-action surface. Gate the
 * Done/Cancel controls on it: a plain widget mount has no calling agent waiting
 * for an artifact, so resolving would be a no-op. Sourced from the host's
 * globalParams (not the URL) — so for an iframe mount it may flip from false to
 * true a tick after mount, once the host answers the ready handshake. Use
 * {@link useIsInteractionSurface} to track it reactively.
 */
export function isInteractionSurface(): boolean {
  return getGlobalParams().interaction === true;
}

// Global-param message names are a wire contract with `packages/web` AppWidget.

const GLOBAL_PARAMS_MESSAGE = "rome:global-params";
const GLOBAL_PARAMS_READY = "rome:global-params:ready";

let globalParamsStore: RomeAppGlobalParams | null = null;
const globalParamsListeners = new Set<(params: RomeAppGlobalParams) => void>();
let globalParamsListenerInstalled = false;

// Seed lazily on first read so merely importing the SDK (tests/SSR) has no side
// effects; the first getter/subscribe an app makes installs the listener and
// announces readiness so the host can push.
function ensureGlobalParamsInit(): void {
  if (globalParamsStore !== null) return;
  globalParamsStore =
    typeof window !== "undefined" ? { ...(window.__ROME_APP_BOOTSTRAP__?.globalParams ?? {}) } : {};
  installGlobalParamsListener();
  postGlobalParamsReady();
}

function installGlobalParamsListener(): void {
  if (globalParamsListenerInstalled || typeof window === "undefined") return;
  globalParamsListenerInstalled = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { type?: unknown; params?: unknown } | null;
    if (!data || typeof data !== "object" || data.type !== GLOBAL_PARAMS_MESSAGE) return;
    if (!data.params || typeof data.params !== "object") return;
    applyGlobalParams(data.params as RomeAppGlobalParams);
  });
}

// Only meaningful for an iframe mount (a distinct parent exists); a same-window
// mount already has the seed and `window.parent === window`, so this no-ops.
function postGlobalParamsReady(): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: GLOBAL_PARAMS_READY }, window.location.origin);
}

function applyGlobalParams(params: RomeAppGlobalParams): void {
  // The host sends the full context each time, so replace rather than merge — a
  // key dropping out (e.g. the surface unbinding from a session) must clear it.
  const next: RomeAppGlobalParams = { ...params };
  globalParamsStore = next;
  if (typeof window !== "undefined" && window.__ROME_APP_BOOTSTRAP__) {
    window.__ROME_APP_BOOTSTRAP__.globalParams = next;
  }
  for (const listener of globalParamsListeners) {
    try {
      listener(next);
    } catch {
      // a misbehaving subscriber must not break the others
    }
  }
}

/**
 * Current host runtime context. Returns a stable reference between changes, so
 * it is safe as a `useSyncExternalStore` snapshot. Empty object until context
 * arrives.
 */
export function getGlobalParams(): RomeAppGlobalParams {
  ensureGlobalParamsInit();
  return globalParamsStore as RomeAppGlobalParams;
}

/**
 * The chat session this surface is bound to, or `null` when unbound or not yet
 * delivered. Distinct from any `?session=` query param an app defines itself.
 */
export function getChatSessionId(): string | null {
  return getGlobalParams().chatSessionId ?? null;
}

/**
 * The host-resolved caller identity for this mount, or `null` when unknown
 * (preview mounts, tests/SSR, or a host that predates caller delivery).
 * Advisory, for UI gating only — see {@link RomeAppCaller}. Static per mount,
 * so it is safe to read once during render.
 */
export function getCaller(): RomeAppCaller | null {
  if (typeof window === "undefined" || !window.__ROME_APP_BOOTSTRAP__) return null;
  return window.__ROME_APP_BOOTSTRAP__.caller ?? null;
}

/**
 * React: the caller identity for this mount. Convenience for
 * `getCaller()?.kind === "guardian"`-style gating, e.g.:
 *
 * ```tsx
 * const isOwner = useCaller()?.kind === "guardian";
 * ```
 */
export function useCaller(): RomeAppCaller | null {
  return getCaller();
}

/**
 * Subscribe to host-context changes. Does not fire on subscribe — pair it with a
 * getter for the current value (as the React hooks below do). Returns an
 * unsubscribe callback.
 */
export function subscribeGlobalParams(listener: (params: RomeAppGlobalParams) => void): () => void {
  ensureGlobalParamsInit();
  globalParamsListeners.add(listener);
  return () => {
    globalParamsListeners.delete(listener);
  };
}

/** React: the live host runtime context. */
export function useGlobalParams(): RomeAppGlobalParams {
  return useSyncExternalStore(subscribeGlobalParams, getGlobalParams, getGlobalParams);
}

/** React: the live chat session id this surface is bound to (or `null`). */
export function useChatSessionId(): string | null {
  return useSyncExternalStore(subscribeGlobalParams, getChatSessionId, getChatSessionId);
}

/** React: whether this surface is an interaction surface, tracked live. */
export function useIsInteractionSurface(): boolean {
  return useSyncExternalStore(subscribeGlobalParams, isInteractionSurface, isInteractionSurface);
}

function postToHost(message: Record<string, unknown>): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(message, window.location.origin);
}

/**
 * Hand `output` back to the agent that opened this surface and resume it. The
 * shape of `output` is the app's contract with that agent; `label` is the short
 * turn label the guardian sees for the resumed step (e.g. "Workflow ready").
 */
export function resolveInteraction(output: Record<string, unknown>, label?: string): void {
  postToHost({ type: INTERACTION_RESOLVE, output, label });
}

/** Close the surface without an artifact — the calling agent resumes with a
 *  dismissed outcome. */
export function dismissInteraction(): void {
  postToHost({ type: INTERACTION_DISMISS });
}

export async function fetchAppApi(path: string = "", init?: RequestInit): Promise<Response> {
  const bootstrap = requireBootstrap();
  const { path: rawPath, query } = splitPathAndQuery(path);
  const normalizedPath = normalizePath(rawPath);
  const normalizedQuery = normalizeQuery(query, path);
  const encodedPath = encodePath(normalizedPath);
  const baseUrl = encodedPath ? `${bootstrap.apiBase}/${encodedPath}` : bootstrap.apiBase;
  const url = normalizedQuery.length > 0 ? `${baseUrl}?${normalizedQuery}` : baseUrl;
  return fetch(url, init);
}

/**
 * Begin the Rome Cloud visitor sign-in flow for this app surface.
 *
 * Use this when a feature needs a verified Rome Cloud visitor — favor request
 * actions (`ctx.favors.requestAction`) being the canonical example: they fail
 * with `visitor_auth_required` until the visitor has a session on this
 * instance. Signing in on romeos.cc alone is not enough; the session cookie
 * must be established on the instance origin through this flow.
 *
 * Redirects the browser to the Rome Cloud authorization page. After the
 * visitor approves, they land back on `next` (default: the current location)
 * with the visitor session set — the remounted surface then reports
 * `useCaller()` as `{ kind: "visitor", ... }`.
 *
 * Only available on publicly reachable app surfaces (public-link or
 * cloud-email access). Throws `visitor_login_unavailable` when the flow
 * cannot be started (e.g. the app is private, or this is a preview mount).
 */
export async function beginVisitorLogin(next?: string): Promise<void> {
  const bootstrap = requireBootstrap();
  const target =
    next ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const res = await fetch("/api/auth/visitor/start", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: bootstrap.appId, next: target }),
  });
  const data = (await res.json().catch(() => null)) as { authorizeUrl?: string } | null;
  if (!res.ok || !data?.authorizeUrl) {
    throw new Error("visitor_login_unavailable");
  }
  window.location.href = data.authorizeUrl;
}

/**
 * End the Rome Cloud visitor session on this instance — the counterpart of
 * {@link beginVisitorLogin}. Clears the visitor session cookie, then reloads
 * the page so the surface remounts with an anonymous caller (identity is
 * fixed per mount — see {@link RomeAppCaller}).
 *
 * Visitor-only: a guardian's dashboard session is never touched, so this is
 * safe to expose inside any app surface. Throws `visitor_logout_failed` when
 * the request fails (e.g. network); on success the reload is already underway
 * when the promise resolves.
 */
export async function visitorLogout(): Promise<void> {
  const res = await fetch("/api/auth/visitor/logout", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("visitor_logout_failed");
  }
  window.location.reload();
}

/**
 * Custom-event name the host listens for. Exported so unit tests / advanced
 * callers can dispatch the same event directly. Apps should call
 * `navigateRome(payload)` instead — the typed surface catches typos.
 */
export const HOST_NAVIGATE_EVENT = "rome:host-navigate";

export type ChatWidget =
  | {
      readonly type: "app";
      readonly appId: string;
      readonly route?: string;
      readonly params?: Readonly<Record<string, string | number | boolean>>;
    }
  | {
      readonly type: "projects";
      readonly selectedPath?: string;
    }
  | {
      readonly type: "desktop";
    };

/**
 * Discriminated union of every host route an app is allowed to deep-link to.
 *
 * Each variant pins `path` to a literal and declares its own params, so a
 * missing or mistyped param is a compile-time error rather than a runtime
 * 404. Add a new destination by appending a variant here AND a case in
 * `resolveHostNavigatePath` — the `never` exhaustiveness check at the
 * bottom of that function turns "forgot to handle it" into a compile error.
 *
 * Kept deliberately narrow: this is the public surface apps see, so
 * anything not listed cannot be linked to.
 */
export type NavigateRomePayload =
  | { readonly path: "chat"; readonly sessionId: string; readonly widgets?: readonly ChatWidget[] }
  | { readonly path: "session"; readonly session: RomeSessionRef }
  /**
   * `draft` pre-fills the chat composer without sending — the guardian edits
   * and commits the message themselves. `skill` pre-pins a
   * structured skill chip on the composer (the counterpart of picking it from
   * the `/` menu), so any catalog skill name works — it is sent as a field,
   * never parsed out of the text. `agentName` and `projectPath` seed the same
   * draft controls the guardian could pick manually before sending.
   */
  | {
      readonly path: "chat/new";
      readonly draft?: string;
      readonly skill?: string;
      readonly agentName?: string;
      readonly projectPath?: string;
      readonly widgets?: readonly ChatWidget[];
    }
  | { readonly path: "settings"; readonly tab?: string }
  | { readonly path: "memory"; readonly file?: string }
  | { readonly path: "apps" }
  | { readonly path: "apps"; readonly appId: string; readonly subPath?: string }
  | { readonly path: "people" }
  | { readonly path: "projects" }
  | { readonly path: "routines" }
  | { readonly path: "desktop" };

/**
 * Send the host to a Rome-owned route. Implemented as a CustomEvent on the
 * shared `window` (the app mounts in a Shadow DOM, not an iframe, so
 * `window` crosses the boundary natively). The host shell listens for the
 * event and routes via react-router's `useNavigate`, so this is a soft
 * navigation — no full page reload, no state loss.
 *
 * No-ops cleanly in non-browser environments (tests / SSR).
 */
export function navigateRome(payload: NavigateRomePayload): void {
  if (typeof window === "undefined") return;
  // `state` rides the event into the host's react-router navigation
  // (location.state), so it never appears in the URL.
  const detail: { path: string; state?: unknown } = {
    path: resolveHostNavigatePath(payload),
  };
  if (payload.path === "chat/new") {
    const state = {
      ...(payload.draft ? { draft: payload.draft } : {}),
      ...(payload.skill ? { skill: payload.skill } : {}),
      ...(payload.agentName ? { agentName: payload.agentName } : {}),
      ...(payload.projectPath ? { projectPath: payload.projectPath } : {}),
      ...(hasWidgets(payload.widgets) ? { widgets: payload.widgets } : {}),
    };
    if (Object.keys(state).length > 0) detail.state = state;
  }
  if (payload.path === "chat" && hasWidgets(payload.widgets)) {
    detail.state = { widgets: payload.widgets };
  }
  window.dispatchEvent(new CustomEvent(HOST_NAVIGATE_EVENT, { detail }));
  if (
    (payload.path === "chat" || payload.path === "chat/new" || payload.path === "session") &&
    window.parent !== window
  ) {
    window.parent.postMessage({ type: HOST_NAVIGATE_EVENT, detail }, window.location.origin);
  }
}

function hasWidgets(widgets: readonly ChatWidget[] | undefined): widgets is readonly ChatWidget[] {
  return Array.isArray(widgets) && widgets.length > 0;
}

function resolveHostNavigatePath(payload: NavigateRomePayload): string {
  switch (payload.path) {
    case "chat":
      return `/chat/${encodeURIComponent(payload.sessionId)}`;
    case "chat/new":
      return "/chat";
    case "session": {
      const { id, type } = readRomeSession(payload.session);
      const route = type === "webchat" ? "chat" : "sessions";
      return `/${route}/${encodeURIComponent(id)}`;
    }
    case "settings":
      return payload.tab ? `/settings/${encodeURIComponent(payload.tab)}` : "/settings";
    case "memory": {
      const file = payload.file?.replace(/^\/+/, "");
      return file ? `/memory/${file.split("/").map(encodeURIComponent).join("/")}` : "/memory";
    }
    case "apps": {
      if (!("appId" in payload)) return "/apps";
      const subPath = payload.subPath?.replace(/^\/+/, "");
      return subPath
        ? `/apps/${encodeURIComponent(payload.appId)}/${subPath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`
        : `/apps/${encodeURIComponent(payload.appId)}`;
    }
    case "people":
      return "/people";
    case "projects":
      return "/projects";
    case "routines":
      return "/routines";
    case "desktop":
      return "/desktop";
    default: {
      // Exhaustiveness check — adding a new variant above without a case
      // here is a TypeScript error at this assignment, not a runtime
      // fallthrough.
      const _exhaustive: never = payload;
      throw new Error(`navigateRome: unhandled payload ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function readRomeSession(session: RomeSessionRef): { id: string; type: RomeSessionType } {
  if (typeof session !== "object" || session === null) {
    throw new TypeError("navigateRome: session must be an opaque RomeSessionRef object");
  }
  const ref = session as { _romeSessionId?: unknown; _type?: unknown };
  const id = ref._romeSessionId;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("navigateRome: session contains no valid Rome session id");
  }
  if (!isRomeSessionType(ref._type)) {
    throw new TypeError("navigateRome: session contains no valid Rome session type");
  }
  return { id, type: ref._type };
}

function isRomeSessionType(value: unknown): value is RomeSessionType {
  return (
    value === "webchat" ||
    value === "webchat_handoff" ||
    value === "channel" ||
    value === "action" ||
    value === "fork" ||
    value === "subagent"
  );
}

export interface StartChatOptions {
  readonly message: string;
  readonly agentName?: string;
  readonly projectPath?: string;
  readonly navigate?: boolean;
  readonly widgets?: readonly ChatWidget[];
  /**
   * Invoke a catalog skill on the first turn, with `message` as its
   * task text — the agent reads the skill before acting, so the opening turn
   * runs a known capability instead of leaving intent to the agent's judgement.
   * An unknown name degrades to a plain-text turn server-side.
   */
  readonly skillName?: string;
}

interface HostWidgetPlacement {
  id: string;
  type: "desktop" | "projects" | "app";
  targetId?: string;
  order: number;
  route?: string;
  params?: Record<string, string | number | boolean>;
  selectedPath?: string;
}

function widgetPlacementId(index: number): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${index}`;
  return `sdk-widget-${random}`;
}

function buildWidgetLayout(widgets: readonly ChatWidget[]): HostWidgetPlacement[] {
  return widgets.flatMap((widget, index): HostWidgetPlacement[] => {
    const base = { id: widgetPlacementId(index), order: index + 1 };
    switch (widget.type) {
      case "app":
        if (!widget.appId) return [];
        return [
          {
            ...base,
            type: "app",
            targetId: widget.appId,
            ...(widget.route !== undefined ? { route: widget.route } : {}),
            ...(widget.params !== undefined ? { params: { ...widget.params } } : {}),
          },
        ];
      case "projects":
        return [
          {
            ...base,
            type: "projects",
            ...(widget.selectedPath !== undefined ? { selectedPath: widget.selectedPath } : {}),
          },
        ];
      case "desktop":
        return [{ ...base, type: "desktop" }];
      default: {
        const _exhaustive: never = widget;
        return _exhaustive;
      }
    }
  });
}

/**
 * High-level helper that starts a fresh webchat session, posts `message`
 * as the first user turn (which kicks off the agent), optionally anchors the
 * session to `projectPath`, and — unless `navigate: false` — sends the host to
 * `/chat/<sessionId>`.
 *
 * Composes two existing routes (`POST /api/chat/sessions` and
 * `POST /api/chat/sessions/:id/turns`); there is no dedicated server
 * endpoint and we don't need one.
 *
 * The first-turn POST is awaited before navigating. The POST returns as soon
 * as the user message is persisted and the turnId allocated (the agent run
 * drains in the background), so this only costs the server's
 * turn-setup latency — not the turn itself. Navigating earlier loses the
 * guardian's own message: the chat page's initial history fetch races the
 * insert, and the session events stream deliberately never re-pushes
 * user-turn rows (the sender is expected to have rendered them).
 */
export async function startChat(opts: StartChatOptions): Promise<{ sessionId: string }> {
  const createSessionBody: {
    agentName: string | null;
    projectPath?: string;
  } = { agentName: opts.agentName ?? null };
  if (opts.projectPath !== undefined) {
    createSessionBody.projectPath = opts.projectPath;
  }

  const sessionRes = await fetch("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(createSessionBody),
  });
  if (!sessionRes.ok) {
    throw new Error(`startChat: could not create session (${sessionRes.status})`);
  }
  const session = (await sessionRes.json()) as { id?: unknown };
  if (typeof session.id !== "string") {
    throw new Error("startChat: session response missing id");
  }
  const sessionId = session.id;

  // Let the host shell (RecentChats) know a new session exists, so the
  // sidebar refetches instead of waiting for a later unrelated mutation.
  window.dispatchEvent(new CustomEvent("rome:chat-sessions-changed"));

  if (hasWidgets(opts.widgets)) {
    const layout = buildWidgetLayout(opts.widgets);
    if (layout.length > 0) {
      try {
        const layoutRes = await fetch(
          `/api/chat/sessions/${encodeURIComponent(sessionId)}/layout`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ layout }),
          },
        );
        if (!layoutRes.ok) {
          console.error(`startChat: layout PUT returned ${layoutRes.status}`);
        }
      } catch (err) {
        console.error("startChat: layout PUT failed", err);
      }
    }
  }

  // Awaited so the user message is persisted before the chat page's initial
  // history fetch. A failure is logged but doesn't block navigation — the
  // chat page already renders a generic error state for sessions with no
  // usable turns.
  try {
    const turnBody: { text: string; skillName?: string } = { text: opts.message };
    if (opts.skillName) turnBody.skillName = opts.skillName;
    const turnRes = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(turnBody),
    });
    if (!turnRes.ok) {
      console.error(`startChat: first turn POST returned ${turnRes.status}`);
    }
  } catch (err) {
    console.error("startChat: first turn POST failed", err);
  }

  if (opts.navigate !== false) {
    navigateRome({ path: "chat", sessionId });
  }
  return { sessionId };
}

/** Host capabilities handed to a live inline component. */
export interface AppComponentHost {
  /**
   * Submit the component's result back to the agent that rendered it. The
   * outcome arrives as the next turn on this chat session, resuming the agent.
   * The shape of `output` is the component's contract with that agent;
   * `summary` is the human-readable line shown in the transcript for the turn.
   */
  submit(output: Record<string, unknown>, summary?: string): void;
  /** Dismiss without a result — the agent resumes with a dismissed outcome. */
  dismiss(): void;
  /** True once this instance has resolved, so the renderer can lock to read-only. */
  readonly resolved: boolean;
}

/** Everything a component renderer receives when the host mounts it. */
export interface AppComponentContext {
  bootstrap: RomeAppBootstrap;
  /** Seed props the action passed in `pendingInteraction.render.props`. */
  props: Record<string, unknown>;
  /** The prior submitted output when re-mounting an already-resolved instance. */
  result?: Record<string, unknown>;
  host: AppComponentHost;
}

/**
 * Renderer for one inline component. Mount your UI into `container`; return an
 * optional cleanup callback run on unmount. May be async (e.g. React
 * `createRoot` + render).
 */
export type AppComponentRenderer = (
  container: HTMLElement,
  ctx: AppComponentContext,
) => void | (() => void) | Promise<void | (() => void)>;

const componentRegistry = new Map<string, AppComponentRenderer>();

/**
 * Register an inline component renderer under `id`. Call at bundle load (top
 * level of your web entry) so the renderer is in the registry by the time the
 * host imports the bundle and calls `mountComponent`.
 */
export function defineComponent(id: string, renderer: AppComponentRenderer): void {
  componentRegistry.set(id, renderer);
}

/** Look up a registered renderer. Used by the generated entry's mountComponent. */
export function getRegisteredComponent(id: string): AppComponentRenderer | undefined {
  return componentRegistry.get(id);
}

export {
  CallerBadge,
  SignInWithRomeCloud,
  useVisitorSignIn,
  type CallerBadgeProps,
  type SignInWithRomeCloudProps,
  type VisitorSignInError,
  type VisitorSignInState,
} from "./visitor-auth.js";
