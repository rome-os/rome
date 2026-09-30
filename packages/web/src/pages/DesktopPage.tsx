import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function applyDesktopSafeAreaBottom(
  iframe: HTMLIFrameElement,
  safeAreaBottom: string,
): void {
  if (!safeAreaBottom) return;
  iframe.contentDocument?.documentElement?.style.setProperty(
    "--rome-safe-area-bottom",
    safeAreaBottom,
  );
}

/** The shared desktop, or with `name` the named desktop Rome core serves under
 *  /desktop-proxy/<name>/. */
export default function DesktopPage({ name }: { name?: string }) {
  const { t } = useTranslation("common");
  const path = name
    ? `desktop-proxy/${encodeURIComponent(name)}/websockify`
    : "desktop-proxy/websockify";
  const title = name ? t("desktop.namedIframeTitle", { name }) : t("desktop.iframeTitle");
  return (
    <div className="h-[var(--rome-mobile-content-height)] bg-foreground md:h-dvh">
      <iframe
        title={title}
        src={`/desktop-vnc.html?resize=scale&path=${encodeURIComponent(path)}`}
        className="block h-full w-full border-0 bg-foreground"
        allow="clipboard-read; clipboard-write"
        onLoad={(event) => {
          const safeAreaBottom = getComputedStyle(document.documentElement)
            .getPropertyValue("--rome-safe-area-bottom")
            .trim();
          applyDesktopSafeAreaBottom(event.currentTarget, safeAreaBottom);
        }}
      />
    </div>
  );
}

/** A name `rome-start-desktop.sh` accepts. `websockify` is the shared desktop's
 *  proxy path, so it would open the shared desktop under this name's title.
 *  DesktopPage encodes the whole path, so other names already reach the proxy
 *  intact and get a 404; this check only spares the guardian a broken view. */
const DESKTOP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `/desktop/:name`. */
export function NamedDesktopPage() {
  const { t } = useTranslation("common");
  const { name = "" } = useParams<{ name: string }>();
  if (!DESKTOP_NAME.test(name) || name === "websockify") {
    return (
      <div className="flex h-[var(--rome-mobile-content-height)] items-center justify-center p-6 text-muted-foreground md:h-dvh">
        {t("desktop.notFound", { name })}
      </div>
    );
  }
  return <DesktopPage name={name} />;
}
