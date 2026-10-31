import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { RomeLogo } from "@/components/RomeLogo";
import { Button } from "@/components/ui/button";
import { romeApi, type RuntimeStatus } from "@/lib/rome-api";
import { RemoteWelcome } from "@/pages/RemoteWelcome";

/**
 * The main window's page until the Rome it opens is ready. Main drives the
 * state; once it reports ready, the window moves on to the Rome itself.
 */
export function OnboardingPage() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const startupRequested = useRef(false);

  useEffect(() => {
    const off = romeApi.on("runtime:status", (next) => {
      setStatus(next);
      if (next.phase === "ready") {
        window.setTimeout(() => {
          window.location.href = next.dashboardUrl;
        }, 600);
      }
    });

    (async () => {
      const current = await romeApi.runtime.getStatus();
      setStatus(current);
      if (!startupRequested.current && current.phase !== "ready") {
        startupRequested.current = true;
        await romeApi.runtime.ensureReady();
      }
    })().catch(console.error);

    return off;
  }, []);

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="app-drag fixed inset-x-0 top-0 z-50 h-10" aria-hidden="true" />
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 pb-8 pt-12">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RomeLogo className="size-5" />
            <span className="text-sm font-semibold tracking-tight">Rome</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="app-no-drag"
            onClick={() => {
              romeApi.settings.openWindow().catch(console.error);
            }}
          >
            Settings
          </Button>
        </header>

        <main className="flex flex-1 flex-col justify-center gap-8 py-10">
          <RemoteWelcome status={status} />
        </main>
      </div>
    </div>
  );
}
