import { ArrowLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useSettingsBack } from "@/hooks/use-settings-back";

/**
 * One service's detail, drilled into from the Connections grids. It replaces the
 * grids where they stood rather than opening over them, because Settings is
 * already a dialog and a second one would stack on it. A non-modal dialog to
 * assistive tech: Escape and the back button both return to the grids.
 */
export function DetailPane({
  label,
  backLabel,
  onClose,
  mark,
  status,
  children,
}: {
  label: string;
  backLabel: string;
  onClose: () => void;
  mark: ReactNode;
  status: ReactNode;
  children: ReactNode;
}) {
  // The card that opened this has just been hidden, which would drop focus.
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => pane.current?.focus(), []);
  useSettingsBack(onClose);

  return (
    <div
      ref={pane}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className="flex w-full max-w-2xl flex-col gap-5 outline-none"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 self-start"
        onClick={onClose}
      >
        <ArrowLeft data-icon="inline-start" aria-hidden />
        {backLabel}
      </Button>
      <div className="flex items-center gap-3">
        {mark}
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-foreground">{label}</h2>
          <div className="mt-1">{status}</div>
        </div>
      </div>
      {children}
    </div>
  );
}
