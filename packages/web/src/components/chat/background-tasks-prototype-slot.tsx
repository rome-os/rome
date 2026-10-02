// PROTOTYPE ONLY (branch prototype/webchat-background-tasks, never merged).
// Mount points for the background-task UI prototype. The dashboard build renders
// nothing here. The mock build swaps this module for
// mock/prototype-background-tasks/slots.tsx (see mock/rsbuild.config.ts).

/** In the chat header, beside the session model label. */
export function BackgroundTasksHeaderSlot(): null {
  return null;
}

/** After the transcript, inside the message scroller. */
export function BackgroundTasksTranscriptSlot(): null {
  return null;
}

/** Directly above the composer, inside its floating floor. */
export function BackgroundTasksComposerSlot(): null {
  return null;
}
