// PROTOTYPE ONLY. Three variants of the webchat background-task UI on /chat/*,
// switchable via ?variant=A|B|C. The mock build swaps
// src/components/chat/background-tasks-prototype-slot.tsx for this module.

import { PrototypeChrome, useVariant } from "./chrome";
import { useProto } from "./store";
import { TranscriptTail } from "./transcript-tail";
import { ComposerTray } from "./variant-a-composer-tray";
import { HeaderIndicator } from "./variant-b-header-indicator";
import { InlineTaskCards } from "./variant-c-inline-cards";

export function BackgroundTasksHeaderSlot() {
  const proto = useProto();
  return useVariant() === "B" ? <HeaderIndicator proto={proto} /> : null;
}

export function BackgroundTasksTranscriptSlot() {
  const proto = useProto();
  const variant = useVariant();
  return (
    <>
      <TranscriptTail
        proto={proto}
        renderStartedTasks={
          variant === "C"
            ? (taskIds) => <InlineTaskCards proto={proto} taskIds={taskIds} />
            : undefined
        }
      />
      <PrototypeChrome proto={proto} />
    </>
  );
}

export function BackgroundTasksComposerSlot() {
  const proto = useProto();
  return useVariant() === "A" ? <ComposerTray proto={proto} /> : null;
}
