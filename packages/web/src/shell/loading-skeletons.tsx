import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RomeLogo } from "@/components/logo";
import { Skeleton } from "@/components/ui/skeleton";

function Pending({ className, children }: { className: string; children: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{t("routeLoading")}</span>
      {children}
    </div>
  );
}

function ContentBones() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-16 w-full max-w-2xl" />
      <Skeleton className="h-16 w-4/5 max-w-xl" />
      <Skeleton className="mt-auto h-12 w-full max-w-2xl" />
    </div>
  );
}

/**
 * Stands in for a route's code while its chunk downloads, inside the shell.
 * Shapes only: it names no page, so it fits any route.
 */
export function RouteLoadingSkeleton() {
  return (
    <Pending className="flex min-h-0 flex-1 flex-col">
      <ContentBones />
    </Pending>
  );
}

/**
 * Fills the window until the auth probe answers. A signed-out visitor is about
 * to be redirected to login, so this shows no navigation, names or counts of
 * the app behind the gate: the brand mark and grey shapes only. The mark is an
 * SVG, which is what makes this the page's first contentful paint.
 */
export function AppLoadingSkeleton() {
  return (
    <Pending className="flex min-h-screen bg-background">
      <div className="hidden w-56 shrink-0 flex-col gap-3 border-r border-border p-4 md:flex">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-4/5" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="px-4 pt-4 md:px-6 md:pt-6">
          <RomeLogo className="size-8 text-subtle-foreground" aria-hidden />
        </div>
        <ContentBones />
      </div>
    </Pending>
  );
}
