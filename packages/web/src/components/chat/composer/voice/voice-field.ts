// The only file that knows every voice input behavior. It creates them on one
// store and passes each one's callbacks to the handlers of another.

import type { StoreApi } from "zustand/vanilla";
import { createBehaviorScope } from "./behavior";
import { createFieldPresence, type PageEvents } from "./field-presence";
import { createListening, type ListeningState, type Transcriber } from "./listening";
import { createNotice, type NoticeDraft } from "./notice";
import { createSpokenInsertion, type TextEditor } from "./spoken-insertion";

export type VoiceFieldState = ListeningState;

export interface VoiceFieldPorts {
  editor: TextEditor;
  transcriber: Transcriber;
  draft: NoticeDraft;
  page: PageEvents;
}

export function createVoiceField(store: StoreApi<VoiceFieldState>, ports: VoiceFieldPorts) {
  const { context, destroy } = createBehaviorScope(store);
  const insertion = createSpokenInsertion(context, { editor: ports.editor });
  const notice = createNotice(context, { draft: ports.draft, ownEdit: insertion.isInserting });
  const listening = createListening(context, {
    transcriber: ports.transcriber,
    started: () => {
      insertion.begin();
      notice.clear();
    },
    heard: insertion.preview,
    ended: (heard, stop) => {
      insertion.commit(heard);
      notice.show(stop);
    },
  });
  const presence = createFieldPresence(context, {
    page: ports.page,
    hidden: listening.stop,
    left: listening.end,
  });
  return { listening, notice, presence, destroy };
}

export type VoiceField = ReturnType<typeof createVoiceField>;
