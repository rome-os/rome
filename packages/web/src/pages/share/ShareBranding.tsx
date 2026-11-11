import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** Where the share page's Rome marks point. */
export const ROME_SITE_URL = "https://romeos.cc";

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

/**
 * The share page's one row of Rome branding: the mark, the name and a tagline
 * on the left, linking to Rome's site, and "Learn about Rome" on the right. The
 * tagline hides on a narrow phone so the row stays one line.
 */
export function ShareHeader() {
  const { t } = useTranslation("chat");
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-4">
      <a
        href={ROME_SITE_URL}
        target="_blank"
        rel="noopener"
        className="flex min-w-0 items-center gap-2 rounded-8 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        <img src="/icon.svg" alt="" className="size-5 shrink-0" />
        <span className="shrink-0 text-ui font-medium text-foreground">Rome</span>
        <span className="truncate text-aux text-muted-foreground max-[400px]:hidden">
          {t("share.tagline")}
        </span>
      </a>
      <Button asChild variant="outline" size="sm" className="ml-auto">
        <a href={ROME_SITE_URL} target="_blank" rel="noopener">
          {t("share.learnAbout")}
        </a>
      </Button>
    </header>
  );
}
