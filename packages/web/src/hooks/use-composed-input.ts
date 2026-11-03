import { type ChangeEvent, type CompositionEvent, useState } from "react";

/**
 * Props for an input whose value lives somewhere a write re-renders it, such
 * as the URL. Replacing the value mid-word breaks an input method's
 * composition, so from composition start until `value` catches up, the input
 * shows a local draft. Outside that window, `value` drives the input.
 */
export function useComposedInput(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null && draft === value) setDraft(null);

  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      const composing = (event.nativeEvent as InputEvent).isComposing;
      if (composing || draft !== null) setDraft(next);
      if (!composing) onCommit(next);
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) =>
      onCommit(event.currentTarget.value),
  };
}
