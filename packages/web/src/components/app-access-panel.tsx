import { useState } from "react";
import { Globe, LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { beginVisitorLogin } from "@/lib/visitor-login";
import { cn } from "@/lib/utils";

export function AppAccessPanel({
  appId,
  appName,
  visitorEmail,
  className,
}: {
  appId: string;
  appName: string;
  visitorEmail?: string | null;
  className?: string;
}) {
  const { t } = useTranslation("apps");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setStarting(true);
    setError("");
    const result = await beginVisitorLogin(appId);
    if (!result.ok) {
      setError(
        result.reason === "network" ? t("accessGate.networkFailed") : t("accessGate.startFailed"),
      );
      setStarting(false);
    }
  }

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-md flex-col items-center rounded-12 border border-border bg-surface px-6 py-8 text-center shadow-1",
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-8 bg-surface-muted text-foreground">
        <Globe className="h-5 w-5" aria-hidden />
      </div>
      <h1 className="mt-4 text-title text-foreground">
        {t("accessGate.title", { name: appName })}
      </h1>
      <p className="mt-2 text-ui text-muted-foreground">
        {visitorEmail
          ? t("accessGate.deniedDescription", { email: visitorEmail })
          : t("accessGate.description")}
      </p>
      {error ? <p className="mt-3 text-ui text-destructive-fg">{error}</p> : null}
      {!visitorEmail ? (
        <Button type="button" className="mt-5" disabled={starting} onClick={() => void start()}>
          <LogIn className="h-4 w-4" aria-hidden />
          {starting ? t("accessGate.signingIn") : t("accessGate.signIn")}
        </Button>
      ) : null}
    </section>
  );
}
