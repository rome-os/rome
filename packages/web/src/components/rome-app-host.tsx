import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { trackAppOpen } from "@/lib/analytics";

export interface RomeAppBootstrap {
  appId: string;
  version: string;
  routeBase: string;
  routePath: string;
  apiBase: string;
  assetBase: string;
  shell: {
    locale: string;
    theme: "light" | "dark";
    themeName: string;
    mode: "embedded" | "full";
  };
  /** Host-resolved caller identity for this mount (advisory, UI gating only). */
  caller?:
    | { kind: "guardian"; userId: string }
    | { kind: "visitor"; accountId: string; email: string }
    | { kind: "anonymous" };
  globalParams?: {
    chatSessionId?: string;
    interaction?: boolean;
  };
}

interface RomeAppModule {
  mount(root: HTMLElement, bootstrap: RomeAppBootstrap): void | Promise<void>;
  unmount?: () => void | Promise<void>;
}

const APP_ROOT_ID = "root";

function rewriteCssAssetUrls(cssText: string, sourceUrl: string): string {
  return cssText
    .replace(
      /@import\s+(url\()?\s*(['"]?)([^'")\s]+)\2\s*\)?/g,
      (match, urlPrefix, _quote, rawUrl) => {
        if (
          rawUrl.startsWith("/") ||
          rawUrl.startsWith("#") ||
          rawUrl.startsWith("data:") ||
          rawUrl.startsWith("http:") ||
          rawUrl.startsWith("https:") ||
          rawUrl.startsWith("//")
        ) {
          return match;
        }
        const resolvedUrl = new URL(rawUrl, sourceUrl).toString();
        if (urlPrefix) return `@import url("${resolvedUrl}")`;
        return `@import "${resolvedUrl}"`;
      },
    )
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _quote, rawUrl) => {
      if (
        rawUrl.startsWith("/") ||
        rawUrl.startsWith("#") ||
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("http:") ||
        rawUrl.startsWith("https:") ||
        rawUrl.startsWith("//")
      ) {
        return match;
      }
      return `url("${new URL(rawUrl, sourceUrl).toString()}")`;
    });
}

function scopeAppCss(cssText: string, sourceUrl: string): string {
  return rewriteCssAssetUrls(cssText, sourceUrl).replaceAll(":root", ":host");
}

export async function appendScopedStyles(
  shadowRoot: ShadowRoot,
  styleUrls: string[],
): Promise<void> {
  if (styleUrls.length === 0) return;
  const styles = await Promise.all(
    styleUrls.map(async (styleUrl) => {
      const response = await fetch(styleUrl, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`Failed to load app stylesheet: ${response.status} ${styleUrl}`);
      }
      const style = document.createElement("style");
      style.setAttribute("data-rome-app-style", styleUrl);
      style.textContent = scopeAppCss(await response.text(), styleUrl);
      return style;
    }),
  );
  shadowRoot.append(...styles);
}

// The app inherits the host's design language for free: Rome's semantic tokens
// (--app-canvas, --primary, …) are inherited custom properties that pierce the
// shadow boundary, and the shell toggles `.dark` on <html> (an ancestor of this
// mount), so the inherited values already track the live theme. App bundles ship
// no theme values of their own (see packages/app-template). A page host adds the
// context alias from `background` to `app-canvas`; an inline chat component keeps
// inheriting the chat context instead. The inner-<body> .dark toggle below remains
// necessary because selectors, unlike inherited properties, do not cross the
// shadow boundary, so the app's Tailwind `dark:` variants need an in-scope .dark.
export function prepareShadowMount(
  host: HTMLDivElement,
  { canvas = "app" }: { canvas?: "app" | "chat" } = {},
): HTMLElement {
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadowRoot.replaceChildren();
  // Page hosts select the app canvas so existing bundles that paint `background`
  // move without a rebuild. Inline components select the chat canvas and keep
  // their outer host transparent. Every other theme value keeps inheriting.
  const canvasCss =
    canvas === "app"
      ? `
      --background: var(--app-canvas);
      background-color: var(--background);`
      : `
      --background: var(--chat-canvas);
      --app-canvas: var(--chat-canvas);
      background-color: transparent;`;
  const shellStyle = document.createElement("style");
  shellStyle.textContent = `
    :host {
      ${canvasCss}
      display: block;
      min-height: inherit;
    }
  `;
  shadowRoot.append(shellStyle);

  const appBody = document.createElement("body");
  const mountRoot = document.createElement("div");
  mountRoot.id = APP_ROOT_ID;
  appBody.append(mountRoot);
  shadowRoot.append(appBody);
  return mountRoot;
}

declare global {
  interface Window {
    __ROME_APP_BOOTSTRAP__?: RomeAppBootstrap;
  }
}

export function RomeAppHost({
  appId,
  appName,
  entryUrl,
  styleUrls,
  bootstrap,
}: {
  appId: string;
  appName: string;
  entryUrl: string;
  styleUrls: string[];
  bootstrap: RomeAppBootstrap;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let mountedModule: RomeAppModule | null = null;

    async function load() {
      try {
        if (!rootRef.current) {
          throw new Error("App mount root is unavailable");
        }
        const mountRoot = prepareShadowMount(rootRef.current);
        await appendScopedStyles(mountRoot.getRootNode() as ShadowRoot, styleUrls);
        const currentBootstrap = bootstrapRef.current;
        window.__ROME_APP_BOOTSTRAP__ = currentBootstrap;
        const module = (await import(entryUrl /* webpackIgnore: true */)) as RomeAppModule;
        if (typeof module.mount !== "function") {
          throw new Error(`App bundle for "${appId}" does not export mount(root, bootstrap)`);
        }
        if (disposed) return;
        mountedModule = module;
        await module.mount(mountRoot, currentBootstrap);
        // Both page surfaces (embedded + full) mount through here; the inline
        // chat surface has its own mount path in AppComponentBlock. Together
        // the two call sites are the complete record of app
        // opens — including surfaces that never change the URL.
        trackAppOpen(appId, currentBootstrap.shell.mode);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void load();

    return () => {
      disposed = true;
      delete window.__ROME_APP_BOOTSTRAP__;
      if (mountedModule?.unmount) {
        void mountedModule.unmount();
      }
      rootRef.current?.shadowRoot?.replaceChildren();
    };
  }, [appId, entryUrl, styleUrls]);

  useEffect(() => {
    const body = rootRef.current?.shadowRoot?.querySelector("body");
    body?.classList.toggle("dark", bootstrap.shell.theme === "dark");
  }, [bootstrap.shell.theme]);

  if (error) {
    return (
      <Alert variant="destructive" className="rounded-12 p-6">
        <AlertTitle className="text-section">Failed to mount {appName}</AlertTitle>
        <AlertDescription className="mt-2">{error}</AlertDescription>
      </Alert>
    );
  }

  return <div ref={rootRef} className="min-h-[420px]" data-app-id={appId} />;
}
