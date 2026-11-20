import { useTranslation } from "react-i18next";

/** The page in the iframe is plain HTML outside i18n, so the dashboard writes its copy. */
function applyDesktopStatusText(iframe: HTMLIFrameElement, reconnecting: string): void {
  const status = iframe.contentDocument?.getElementById("connection-status");
  if (status) status.textContent = reconnecting;
}

function applyDesktopSafeAreaBottom(iframe: HTMLIFrameElement, safeAreaBottom: string): void {
  if (!safeAreaBottom) return;
  iframe.contentDocument?.documentElement?.style.setProperty(
    "--rome-safe-area-bottom",
    safeAreaBottom,
  );
}

/** The shared desktop. */
export default function DesktopPage() {
  const { t } = useTranslation("common");
  const path = "desktop-proxy/websockify";
  const title = t("desktop.iframeTitle");
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
          applyDesktopStatusText(event.currentTarget, t("desktop.reconnecting"));
        }}
      />
    </div>
  );
}
