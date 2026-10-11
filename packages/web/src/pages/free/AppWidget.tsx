import { useEffect, useMemo, useRef, useState } from "react";
import { useApps } from "@/hooks/use-apps";
import { trackWidgetRender } from "@/lib/analytics";
import { buildFullAppPath } from "./widget-links";
import { useWorkspaceContextRegistry } from "./workspace-context";

// Wire contract with the app-web-sdk global-params channel: the app
// posts READY once its SDK is live, we answer with the current host context, and
// re-post on change. Keep in sync with packages/app-web-sdk runtime.
const GLOBAL_PARAMS_MESSAGE = "rome:global-params";
const GLOBAL_PARAMS_READY = "rome:global-params:ready";

interface AppWidgetProps {
  appId: string;
  /**
   * Workspace placement id — used to register the iframe ref so the
   * workspace-context registry can read its URL at turn-send time.
   */
  placementId?: string;
  /**
   * The chat session this dashboard is showing. Delivered to the app over the
   * global-params channel (NOT the URL query — the query is the app's own) as
   * `globalParams.chatSessionId`, so a session-aware app (e.g. the Workflow
   * Studio storyboard panel) scopes itself to the active conversation and
   * updates in place when it changes.
   */
  sessionId?: string | null;
  /**
   * Marks this mount as a suspendable-action surface (delivered as
   * `globalParams.interaction`), so the app shows its own Done/Cancel and drives
   * resolution via the app-web-sdk bridge.
   */
  interaction?: boolean;
  /** In-app route — rides the src path (`/full/apps/<appId>/<route>`). */
  route?: string;
  /** Flat scalar params appended to the src as query keys (e.g. `orderId`). */
  params?: Record<string, string | number | boolean>;
  dragging: boolean;
}

export function AppWidget({
  appId,
  placementId,
  sessionId,
  interaction,
  route,
  params,
  dragging,
}: AppWidgetProps) {
  // `route` is the app's own route: it rides the PATH after the appId, which the
  // host forwards to the app as `bootstrap.routePath` (App.tsx `/full/apps/:appId/*`
  // → AppFullPage). `params` is the app's own query — host context (session,
  // interaction) is NOT mixed in here; it rides the global-params channel below.
  // Freeze the app's own route/params at mount. After mount the iframe owns its
  // navigation; the host *reads* that live location back into the placement
  // (use-free-cells `updatePlacementLink`) purely to persist it, and must not
  // feed it back as a fresh `src` — that would reload the iframe out from under
  // the user (and self-trigger on every capture). An agent retarget instead
  // arrives as a new placement id (a fresh mount), so it still takes effect.
  const [frozen] = useState<{ route?: string; params?: AppWidgetProps["params"] }>(() => ({
    route,
    params,
  }));
  const src = buildFullAppPath(appId, frozen.route, frozen.params);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const registry = useWorkspaceContextRegistry();
  // The frame's accessible name must match the tile header, which renders the
  // installed app's display name; the id is only the fallback while the
  // catalog loads.
  const { apps } = useApps();
  const frameTitle = (apps ?? []).find((a) => a.id === appId)?.displayName ?? appId;

  // Host runtime context handed to the app out-of-band: the chat
  // session this tile is bound to + whether it's an interaction surface. Kept
  // off the iframe `src` so the URL query stays purely the app's own. Unlike
  // `route`/`params` this stays LIVE — when a draft promotes to a real session
  // (or the conversation switches) the app updates in place rather than the
  // tile reloading.
  const globalParams = useMemo(() => {
    const params: { chatSessionId?: string; interaction?: boolean } = {};
    if (sessionId) params.chatSessionId = sessionId;
    if (interaction) params.interaction = true;
    return params;
  }, [sessionId, interaction]);
  // Latest value for the ready handler (which has stable deps and would
  // otherwise close over a stale snapshot).
  const globalParamsRef = useRef(globalParams);
  globalParamsRef.current = globalParams;

  // Answer the app's ready handshake with the current context. The app may post
  // ready again after an iframe reload, so this keeps responding for the mount's
  // whole life.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data !== "object" || data.type !== GLOBAL_PARAMS_READY) return;
      iframeRef.current?.contentWindow?.postMessage(
        { type: GLOBAL_PARAMS_MESSAGE, params: globalParamsRef.current },
        window.location.origin,
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Push updates after the app is live. The initial value is covered by the
  // ready handshake (the iframe may not be listening yet on first render); this
  // covers later changes while mounted.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: GLOBAL_PARAMS_MESSAGE, params: globalParams },
      window.location.origin,
    );
  }, [globalParams]);

  useEffect(() => {
    if (!registry || !placementId) return;
    registry.registerApp(placementId, appId, iframeRef.current);
    return () => {
      registry.registerApp(placementId, appId, null);
    };
  }, [registry, placementId, appId]);

  // Widget renders are counted from this parent window. The iframe loads the
  // same SPA but never loads GA there, so a render is an
  // event, not a page view. Keyed to the mount — an agent retarget arrives as
  // a new placement id, i.e. a fresh mount and a fresh event.
  useEffect(() => {
    trackWidgetRender(appId);
  }, [appId]);

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        title={frameTitle}
        src={src}
        className="block h-full w-full border-0"
      />
      {dragging && <div className="absolute inset-0 z-10" />}
    </div>
  );
}
