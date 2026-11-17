import { Eye, EyeOff } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

/** The eye that flips a secret between hidden and shown. The caller owns the state. */
export function RevealToggle({
  shown,
  onToggle,
  showLabel,
  hideLabel,
  disabled,
  className,
}: {
  shown: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <IconButton
      size="sm"
      label={shown ? hideLabel : showLabel}
      icon={shown ? <EyeOff /> : <Eye />}
      aria-pressed={shown}
      onClick={onToggle}
      disabled={disabled}
      className={className}
    />
  );
}
