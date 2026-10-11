import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";

export const AI_TOOL_ACTION_BUTTON_CLASS = "rounded-8 bg-surface-elevated hover:bg-surface-hover";

export type AiToolSignInMethod = {
  id: string;
  label: string;
  onClick: () => void;
};

interface Props {
  methods: AiToolSignInMethod[];
  className?: string;
}

/**
 * Equal-weight sign-in options for an AI tool (e.g. ChatGPT browser + terminal).
 * Renders attached buttons when there is more than one method.
 */
export function AiToolSignInButtons({ methods, className }: Props) {
  if (methods.length === 0) return null;

  if (methods.length === 1) {
    const only = methods[0];
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={only.onClick}
        className={cn(AI_TOOL_ACTION_BUTTON_CLASS, className)}
      >
        {only.label}
      </Button>
    );
  }

  return (
    <ButtonGroup className={className}>
      {methods.map((method) => (
        <Button
          key={method.id}
          type="button"
          variant="outline"
          size="sm"
          onClick={method.onClick}
          className={AI_TOOL_ACTION_BUTTON_CLASS}
        >
          {method.label}
        </Button>
      ))}
    </ButtonGroup>
  );
}
