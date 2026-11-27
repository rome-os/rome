import type { ClipboardEvent } from "react";
import { Mail } from "lucide-react";
import { Input } from "@/components/ui/input";
import { isImeCompositionEvent } from "@rome-os/ui/keyboard-submit";

/**
 * The email field of an access allow-list. Enter commits the typed text, the
 * same as Add.
 */
export function AccessEmailInput({
  id,
  value,
  onChange,
  onCommit,
  onPaste,
  disabled,
  invalid,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Adds `raw`, the typed text, to the list. */
  onCommit: (raw: string) => void;
  onPaste: (event: ClipboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
}) {
  return (
    <Input
      id={id}
      size="md"
      icon={<Mail />}
      // Text, not email, so the field keeps exactly what was typed, a list of
      // addresses included.
      type="text"
      inputMode="email"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        // An input method's Enter confirms a candidate, not the field.
        if (isImeCompositionEvent(event) || event.key !== "Enter") return;
        event.preventDefault();
        onCommit(value);
      }}
      onPaste={onPaste}
      disabled={disabled}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      aria-invalid={invalid ? true : undefined}
    />
  );
}
