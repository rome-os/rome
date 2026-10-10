import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitFork } from "lucide-react";
import type { AppRemixStoreIntent, AppRemixStorePin } from "@rome/api-types/apps";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { resolveRemixListing } from "@/lib/app-remix";

interface Props {
  intent: AppRemixStoreIntent;
  onConfirm: (source: AppRemixStorePin) => void;
  onCancel: () => void;
  inDialog?: boolean;
}

export function AppStoreRemixConfirm({ intent, onConfirm, onCancel, inDialog = false }: Props) {
  const { t } = useTranslation("apps");
  const [attempt, setAttempt] = useState(0);
  const key = `${intent.listingId}@${intent.version}:${attempt}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    detail: ReturnType<typeof resolveRemixListing>;
    error: "unavailable" | "loadFailed" | null;
  } | null>(null);
  const confirmed = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    confirmed.current = false;
    const path = intent.listingId.split("/").map(encodeURIComponent).join("/");
    async function load() {
      try {
        const response = await fetch(`/api/app-store/listings/${path}`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 404 || response.status === 410) {
          if (!controller.signal.aborted) setLoaded({ key, detail: null, error: "unavailable" });
          return;
        }
        if (!response.ok) throw new Error("Listing request failed");
        const detail = resolveRemixListing(intent, await response.json());
        if (!controller.signal.aborted)
          setLoaded({ key, detail, error: detail ? null : "unavailable" });
      } catch {
        if (!controller.signal.aborted) setLoaded({ key, detail: null, error: "loadFailed" });
      }
    }
    void load();
    return () => controller.abort();
  }, [key, intent.listingId, intent.version]);

  const current = loaded?.key === key ? loaded : null;
  const detail = current?.detail;
  const Title = inDialog ? DialogTitle : "h1";
  return (
    <section className="flex flex-col gap-4" aria-busy={!current}>
      <GitFork className="size-8 text-primary" aria-hidden />
      <Title className="text-title text-foreground">{t("remixStore.title")}</Title>
      {!current ? (
        <p role="status" className="text-ui text-muted-foreground">
          {t("install.loading")}
        </p>
      ) : null}
      {current?.error ? (
        <p role="alert" className="text-ui text-destructive">
          {t(`remixStore.${current.error}`)}
        </p>
      ) : null}
      {detail ? (
        <>
          <div>
            <p className="text-ui text-foreground">{detail.name}</p>
            <p className="break-all text-ui text-muted-foreground">
              {detail.pin.listingId} · v{detail.pin.version}
            </p>
          </div>
          <p className="text-ui text-muted-foreground">{t("remixStore.description")}</p>
          <p className="text-ui text-muted-foreground">{t("remixStore.installNotice")}</p>
        </>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {t("remixStore.cancel")}
        </Button>
        {current?.error ? (
          <Button onClick={() => setAttempt((value) => value + 1)}>{t("listing.retry")}</Button>
        ) : (
          <Button
            disabled={!detail}
            onClick={() => {
              if (!detail || confirmed.current) return;
              confirmed.current = true;
              onConfirm(detail.pin);
            }}
          >
            {t("remixStore.confirm")}
          </Button>
        )}
      </div>
    </section>
  );
}
