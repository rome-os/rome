import { useTranslation } from "react-i18next";

/** Each desktop the guardian can watch: the shared one, and WeChat's own display
 *  (`WECHAT_USER_DISPLAY`, served under /desktop-proxy/wechat). */
const views = {
  shared: { path: "desktop-proxy/websockify", titleKey: "desktop.iframeTitle" },
  wechat: { path: "desktop-proxy/wechat/websockify", titleKey: "desktop.wechatIframeTitle" },
} as const;

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

export default function DesktopPage({ view = "shared" }: { view?: keyof typeof views }) {
  const { t } = useTranslation("common");
  const { path, titleKey } = views[view];
  return (
    <div className="h-[var(--rome-mobile-content-height)] bg-foreground md:h-dvh">
      <iframe
        title={t(titleKey)}
        src={`/desktop-vnc.html?resize=scale&path=${path}`}
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
