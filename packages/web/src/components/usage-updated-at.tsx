import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export function UsageUpdatedAt({
  checkedAt,
  className,
}: {
  checkedAt?: string;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const checked = Date.parse(checkedAt ?? "");
  if (!Number.isFinite(checked)) return null;
  const minutes = Math.max(0, Math.floor((now - checked) / 60_000));
  const label =
    minutes < 1
      ? t("aiTools.usage.updatedJustNow")
      : minutes < 60
        ? t("aiTools.usage.updated", { count: minutes })
        : t("aiTools.usage.updatedHours", { count: Math.floor(minutes / 60) });
  return <p className={cn("text-aux text-muted-foreground", className)}>{label}</p>;
}
