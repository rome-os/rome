import type { ReactNode } from "react";
import { PageTitle } from "@rome-os/ui/page";

export function ActivityHeader({
  title,
  viewSwitch,
  actions,
  children,
}: {
  title: string;
  viewSwitch?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-border bg-background px-5 py-3 max-[360px]:px-2">
      <PageTitle className="sr-only">{title}</PageTitle>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-h-[var(--control-h-md)] shrink-0 items-center">{viewSwitch}</div>
        {children}
        {actions ? (
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
