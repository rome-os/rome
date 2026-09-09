import { useEffect, useRef, useState } from "react";
import {
  appendScopedStyles,
  prepareShadowMount,
  type RomeAppBootstrap,
} from "@/components/rome-app-host";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { trackAppOpen } from "@/lib/analytics";
import { useTheme } from "@/hooks/use-theme";
import { getActiveLocale } from "@/i18n";

interface AppManifestResponse {
  appId: string;
  appName: string;
  entryUrl: string;
  styleUrls: string[];
  bootstrap: RomeAppBootstrap;
}

// The bridge handed to a live inline component. Mirrors @rome-os/app-web-sdk's
// AppComponentHost. Because the component runs in this same page context (shadow
// DOM, not an iframe), `submit`/`dismiss` are direct function calls — no
// postMessage round-trip like the suspendable-action surface needs.
interface AppComponentHost {
  submit(output: Record<string, unknown>, summary?: string): void;
  dismiss(): void;
  readonly resolved: boolean;
}

interface AppComponentContext {
  bootstrap: RomeAppBootstrap;
  props: Record<string, unknown>;
  result?: Record<string, unknown>;
  host: AppComponentHost;
}

interface RomeAppComponentModule {
  mountComponent(
    container: HTMLElement,
    componentId: string,
    ctx: AppComponentContext,
  ): void | Promise<void>;
  unmountComponent?(container: HTMLElement): void | Promise<void>;
}

export interface AppComponentBlockProps {
  toolUseId: string;
  appId: string;
  componentId: string;
  props?: Record<string, unknown>;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (toolUseId: string, output: Record<string, unknown>, summary?: string) => void;
  onDismiss: (toolUseId: string) => void;
}

/**
 * Mounts an app-provided component inline in the transcript. Fetches the app's
 * manifest, loads its bundle into a chat-row shadow root, and calls the
 * bundle's `mountComponent` with a host bridge. The component lives entirely in
 * the app — core only transported the `app_component` part that named it.
 */
export function AppComponentBlock({
  toolUseId,
  appId,
  componentId,
  props,
  result,
  onSubmit,
  onDismiss,
}: AppComponentBlockProps) {
  const { resolved: theme, theme: themeName } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Latest callbacks/props without re-running the mount effect (which would tear
  // down and rebuild the live component on every parent render).
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const resolved = result !== undefined;

  useEffect(() => {
    let disposed = false;
    let mountedModule: RomeAppComponentModule | null = null;
    let mountRoot: HTMLElement | null = null;

    async function load() {
      try {
        const params = new URLSearchParams({ mode: "embedded", path: "" });
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/manifest?${params}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || `Failed to load app "${appId}"`);
        }
        const manifest = (await res.json()) as AppManifestResponse;
        if (disposed || !rootRef.current) return;

        const bootstrap: RomeAppBootstrap = {
          ...manifest.bootstrap,
          shell: {
            ...manifest.bootstrap.shell,
            theme,
            themeName,
            locale: getActiveLocale(),
          },
        };

        mountRoot = prepareShadowMount(rootRef.current);
        await appendScopedStyles(mountRoot.getRootNode() as ShadowRoot, manifest.styleUrls);
        if (disposed) return;

        // The app's fetchAppApi() reads this global. Single-app-at-a-time is the
        // same assumption the full-page host makes; concurrent inline components
        // from *different* apps that both call fetchAppApi mid-render would race
        // here — out of scope for the prototype.
        window.__ROME_APP_BOOTSTRAP__ = bootstrap;

        const module = (await import(
          manifest.entryUrl /* @vite-ignore */ /* webpackIgnore: true */
        )) as RomeAppComponentModule;
        if (typeof module.mountComponent !== "function") {
          throw new Error(`App "${appId}" bundle does not export mountComponent()`);
        }
        if (disposed) return;
        mountedModule = module;

        const host: AppComponentHost = {
          resolved,
          submit: (output, summary) => submitRef.current(toolUseId, output, summary),
          dismiss: () => dismissRef.current(toolUseId),
        };
        await module.mountComponent(mountRoot, componentId, {
          bootstrap,
          props: props ?? {},
          result,
          host,
        });
        // Inline components bypass RomeAppHost (the URL stays on /chat), so
        // this mount path reports its own app open.
        trackAppOpen(
          appId,
          "inline",
          bootstrap.caller && "email" in bootstrap.caller ? bootstrap.caller.email : undefined,
        );
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void load();

    return () => {
      disposed = true;
      if (mountedModule?.unmountComponent && mountRoot) {
        void mountedModule.unmountComponent(mountRoot);
      }
      rootRef.current?.shadowRoot?.replaceChildren();
    };
    // Re-mount only when the identity or seed inputs change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, componentId, toolUseId, resolved, theme, themeName]);

  if (error) {
    return (
      <Alert variant="destructive" className="mb-4 rounded-12">
        <AlertDescription>
          Couldn’t load <span className="font-mono">{componentId}</span> from{" "}
          <span className="font-mono">{appId}</span>: {error}
        </AlertDescription>
      </Alert>
    );
  }

  return <div ref={rootRef} className="mb-4" />;
}
