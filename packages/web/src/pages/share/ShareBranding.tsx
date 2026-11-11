import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** Where the share page's Rome marks point. */
export const ROME_SITE_URL = "https://romeos.io";

/**
 * Asks search engines not to index the shared page or follow its links while
 * it is mounted. The server sends the same `X-Robots-Tag`; this covers a
 * crawler that reads only the rendered document.
 */
export function useNoIndex(): void {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

/** The share page's slim top bar: Rome's mark and name, linking to Rome's site. */
export function ShareHeader() {
  return (
    <header className="flex h-12 shrink-0 items-center px-4">
      <a
        href={ROME_SITE_URL}
        target="_blank"
        rel="noopener"
        className="flex items-center gap-2 rounded-8 text-ui font-medium text-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        <img src="/icon.svg" alt="" className="size-5" />
        Rome
      </a>
    </header>
  );
}

/** The share page's closing line, saying what made the page. */
export function ShareFooter() {
  const { t } = useTranslation("chat");
  return (
    // `pb-safe` keeps the line clear of a phone's home indicator.
    <footer className="shrink-0 pb-safe">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-6 text-aux text-muted-foreground">
        <span>{t("share.madeWith")}</span>
        <Button asChild variant="outline" size="sm">
          <a href={ROME_SITE_URL} target="_blank" rel="noopener">
            {t("share.learnAbout")}
          </a>
        </Button>
      </div>
    </footer>
  );
}
