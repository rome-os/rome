import type { ReactNode } from "react";
import { Spinner } from "@rome-os/ui/spinner";
import { LanguageSwitcher } from "@/components/language-switcher";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The frame of the pre-auth pages (/login, /connect): the Rome mark, one
 * title, the page's actions in a narrow centred column, and the language
 * picker at the foot of the page. No card: the page holds one action, so a
 * box around it would frame nothing else.
 */
export function AuthScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-background px-4 pb-safe pt-safe">
      <div className="flex flex-1 items-center justify-center py-12">
        <div className="flex w-full max-w-[320px] flex-col items-center text-center">
          <RomeLogo cutoutFace className="h-10 w-10 text-foreground" aria-hidden />
          <h1 className="mt-5 mb-8 text-display [text-wrap:balance] text-foreground">{title}</h1>
          {children}
        </div>
      </div>
      <div className="flex justify-center pb-4">
        <LanguageSwitcher />
      </div>
    </main>
  );
}

/**
 * A full-width action that starts a redirect. While `busy`, a spinner leads
 * the label and further clicks are ignored; the button stays in its own
 * colour (aria-disabled, not `disabled`), because a faded primary reads as
 * broken rather than working.
 */
export function AuthActionButton({
  busy,
  busyLabel,
  onClick,
  variant = "default",
  className,
  children,
}: {
  busy: boolean;
  busyLabel: string;
  onClick: () => void;
  variant?: "default" | "outline";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="md"
      variant={variant}
      className={cn("w-full touch-target", className)}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {busy ? (
        <>
          <Spinner data-icon="inline-start" label={busyLabel} />
          <span aria-hidden>{busyLabel}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/** A sign-in failure: one line under the action it belongs to. */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-3 break-words text-ui [text-wrap:pretty] text-destructive-fg">
      {children}
    </p>
  );
}
